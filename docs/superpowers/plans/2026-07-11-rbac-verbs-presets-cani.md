# RBAC verbs / presets / can-i Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the RBAC panel with resource-aware verb suggestions (HELM-83), starter role presets (HELM-84), and an inline `kubectl auth can-i` access test in the New binding dialog and Role detail view (HELM-85).

**Architecture:** HELM-83 widens the `/api/api-resources` parser to capture the per-resource VERBS column (`-o wide`, comma-separated) and narrows the RoleEditor VERBS combobox to a rule's picked resources. HELM-84 adds a constant `ROLE_PRESETS` table + preset pill row to the New role dialog. HELM-85 adds a read-only `POST /api/rbac/can-i` route (impersonating each subject) plus a shared `AccessTest` component reused by the binding dialog and role detail.

**Tech Stack:** TypeScript, Node (`apps/server`), React 19 + Vite + TanStack Query (`apps/web`), `@rigel/k8s` kubectl runner, vitest.

---

## File Structure

- `apps/server/src/apiResources.ts` — parser gains `verbsByResource` (HELM-83).
- `apps/server/src/rbacCanI.ts` (new) — impersonation/resource/parse helpers + `runCanI` (HELM-85).
- `apps/server/src/index.ts` — `POST /api/rbac/can-i` route (HELM-85).
- `apps/web/src/lib/api.ts` — `useApiResources` verbsByResource; `postCanICheck` (HELM-83/85).
- `apps/web/src/panels/rbac/canI.ts` (new) — `CanICheck`/`CanIResult` types + `rulesToChecks` (HELM-85).
- `apps/web/src/panels/rbac/components/RoleEditor.tsx` — verb narrowing + presets (HELM-83/84).
- `apps/web/src/panels/rbac/components/AccessTest.tsx` (new) — shared per-subject test widget (HELM-85).
- `apps/web/src/panels/rbac/components/BindingEditor.tsx` — TEST ACCESS section (HELM-85).
- `apps/web/src/panels/rbac/components/RoleDetail.tsx` — per-subject test in "Bound to" (HELM-85).
- `apps/web/src/panels/rbac/RbacPanel.tsx` — wires `rulesForRole` into BindingEditor (HELM-85).

---

## Task 1: Server — per-resource verbs in `/api/api-resources` (HELM-83)

**Files:**
- Modify: `apps/server/src/apiResources.ts`
- Test: `apps/server/src/apiResources.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/apiResources.test.ts`. Replace the `SAMPLE` const and the two `getApiResources` tests, and add verbs assertions:

```ts
const SAMPLE = `
bindings                     v1              true    Binding      create,delete,get
configmaps          cm       v1              true    ConfigMap    create,delete,deletecollection,get,list,patch,update,watch  all
deployments         deploy   apps/v1         true    Deployment   create,delete,deletecollection,get,list,patch,update,watch  all
events              ev       events.k8s.io/v1 true   Event        get,list,watch
events              ev       v1              true    Event        create,patch,update
`;

test("parseApiResources: parses names, groups, and per-resource verbs", () => {
  const { resources, groups, verbsByResource } = parseApiResources(SAMPLE);
  expect(resources).toEqual(["bindings", "configmaps", "deployments", "events"]);
  expect(groups).toEqual(["apps", "core", "events.k8s.io"]);
  expect(verbsByResource["deployments"]).toEqual([
    "create", "delete", "deletecollection", "get", "list", "patch", "update", "watch",
  ]);
  // same resource name under two apiVersions → unioned + sorted
  expect(verbsByResource["events"]).toEqual(["create", "get", "list", "patch", "update", "watch"]);
});

test("parseApiResources: resource with no shortname parses verbs", () => {
  const { resources, verbsByResource } = parseApiResources(
    "bindings                     v1              true    Binding      create,delete,get",
  );
  expect(resources).toEqual(["bindings"]);
  expect(verbsByResource["bindings"]).toEqual(["create", "delete", "get"]);
});

test("parseApiResources: empty input → empty result", () => {
  expect(parseApiResources("")).toEqual({ resources: [], groups: [], verbsByResource: {} });
});

test("getApiResources: requests -o wide and parses on success", async () => {
  mockKubectl.mockResolvedValue({ code: 0, stdout: SAMPLE, stderr: "" });
  const result = await getApiResources("my-context");
  expect(mockKubectl).toHaveBeenCalledWith("my-context", ["api-resources", "-o", "wide", "--no-headers"]);
  expect(result.verbsByResource["deployments"]).toContain("patch");
});

test("getApiResources: non-zero exit → empty result, never throws", async () => {
  mockKubectl.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
  expect(await getApiResources(null)).toEqual({ resources: [], groups: [], verbsByResource: {} });
});
```

Remove the old `parseApiResources: parses the sample columnar output`, `skips malformed/blank lines` (keep a malformed case if you like — rewrite it to include verbs or drop the verbs assertion), `empty input`, and the two old `getApiResources` tests that they supersede.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test apiResources`
Expected: FAIL — `verbsByResource` is `undefined` / call arg mismatch.

- [ ] **Step 3: Implement**

Rewrite `apps/server/src/apiResources.ts`:

```ts
// Parses `kubectl api-resources -o wide --no-headers` into distinct resource
// names, API groups, and the verbs each resource supports, for the RBAC role
// editor's rule autocompletion.
import { kubectl } from "@rigel/k8s/src/run";

export interface ApiResourcesResult {
  resources: string[];
  groups: string[];
  verbsByResource: Record<string, string[]>;
}

export function parseApiResources(stdout: string): ApiResourcesResult {
  const resources = new Set<string>();
  const groups = new Set<string>();
  const verbs = new Map<string, Set<string>>();

  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/).filter((c) => c !== "");
    if (cols.length < 4) continue;
    const namespacedIdx = cols.findIndex((c) => c === "true" || c === "false");
    if (namespacedIdx < 2) continue;
    const apiVersion = cols[namespacedIdx - 1];
    const name = cols[0];
    const slash = apiVersion.lastIndexOf("/");
    const group = slash === -1 ? "core" : apiVersion.slice(0, slash);
    resources.add(name);
    groups.add(group);
    // -o wide adds KIND (namespacedIdx+1) then a comma-separated VERBS column.
    const verbCol = cols[namespacedIdx + 2];
    if (verbCol) {
      const set = verbs.get(name) ?? new Set<string>();
      for (const v of verbCol.split(",")) if (v) set.add(v);
      verbs.set(name, set);
    }
  }

  const verbsByResource: Record<string, string[]> = {};
  for (const [name, set] of verbs) verbsByResource[name] = [...set].sort();

  return {
    resources: [...resources].sort(),
    groups: [...groups].sort(),
    verbsByResource,
  };
}

export async function getApiResources(context: string | null): Promise<ApiResourcesResult> {
  const res = await kubectl(context, ["api-resources", "-o", "wide", "--no-headers"]);
  if (res.code !== 0) return { resources: [], groups: [], verbsByResource: {} };
  return parseApiResources(res.stdout);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/server test apiResources`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/apiResources.ts apps/server/src/apiResources.test.ts
git commit -m "feat(server): api-resources reports per-resource verbs (HELM-83)"
```

---

## Task 2: Client — narrow VERBS combobox to a rule's resources (HELM-83)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`ApiResourcesResponse`, `fetchApiResources`)
- Modify: `apps/web/src/panels/rbac/components/RoleEditor.tsx`
- Test: `apps/web/src/panels/rbac/components/RoleEditor.test.tsx`

- [ ] **Step 1: Extend the client response type**

In `apps/web/src/lib/api.ts`, update the interface and fetch (around line 1063-1073):

```ts
export interface ApiResourcesResponse {
  resources: string[];
  groups: string[];
  verbsByResource: Record<string, string[]>;
}

async function fetchApiResources(): Promise<ApiResourcesResponse> {
  const res = await apiFetch("/api/api-resources");
  if (!res.ok) return { resources: [], groups: [], verbsByResource: {} };
  const data = (await res.json()) as Partial<ApiResourcesResponse>;
  return {
    resources: data.resources ?? [],
    groups: data.groups ?? [],
    verbsByResource: data.verbsByResource ?? {},
  };
}
```

- [ ] **Step 2: Write the failing test**

Add to `apps/web/src/panels/rbac/components/RoleEditor.test.tsx`. First update the fetch stub `beforeEach` to include verbs:

```ts
return new Response(JSON.stringify({
  resources: ["pods", "deployments"],
  groups: ["core", "apps"],
  verbsByResource: { pods: ["get", "list", "watch"], deployments: ["create", "get", "patch"] },
}));
```

Then add a unit test for the pure helper (exported from RoleEditor):

```ts
import { RoleEditor, verbSuggestionsForResources } from "./RoleEditor";

test("verbSuggestionsForResources: unions picked resources' verbs + '*'", () => {
  const vbr = { pods: ["get", "list"], deployments: ["create", "get"] };
  expect(verbSuggestionsForResources(["pods", "deployments"], vbr)).toEqual(["*", "create", "get", "list"]);
});

test("verbSuggestionsForResources: no data → full RBAC verb list", () => {
  expect(verbSuggestionsForResources([], {})).toContain("deletecollection");
  expect(verbSuggestionsForResources(["crd-not-registered"], { pods: ["get"] })).toContain("escalate");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test RoleEditor`
Expected: FAIL — `verbSuggestionsForResources` is not exported.

- [ ] **Step 4: Implement the helper + per-rule wiring**

In `apps/web/src/panels/rbac/components/RoleEditor.tsx`, keep `RBAC_VERBS` and export the helper below it:

```ts
export function verbSuggestionsForResources(
  resources: string[],
  verbsByResource: Record<string, string[]>,
): string[] {
  const known = resources
    .map((r) => verbsByResource[r])
    .filter((v): v is string[] => Array.isArray(v) && v.length > 0);
  if (known.length === 0) return RBAC_VERBS;
  const union = new Set<string>();
  for (const vs of known) for (const v of vs) union.add(v);
  union.add("*");
  return [...union].sort();
}
```

In the component, read `verbsByResource` from the hook (near the existing `groupSuggestions`/`resourceSuggestions` memos):

```ts
const verbsByResource = apiResources?.verbsByResource ?? {};
```

Change the VERBS `TokenInput` (currently `suggestions={RBAC_VERBS}`) to per-rule suggestions:

```tsx
<TokenInput
  label="VERBS"
  tokens={r.verbs ?? []}
  onChange={(t) => setRule(i, { verbs: t })}
  danger={(t) => ["*", "escalate", "bind", "impersonate"].includes(t)}
  suggestions={verbSuggestionsForResources(r.resources ?? [], verbsByResource)}
/>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter web test RoleEditor`
Expected: PASS. Then `pnpm --filter web typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/panels/rbac/components/RoleEditor.tsx apps/web/src/panels/rbac/components/RoleEditor.test.tsx
git commit -m "feat(rbac): narrow VERBS suggestions to a rule's resources (HELM-83)"
```

---

## Task 3: Role presets in the New role dialog (HELM-84)

**Files:**
- Modify: `apps/web/src/panels/rbac/components/RoleEditor.tsx`
- Test: `apps/web/src/panels/rbac/components/RoleEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `RoleEditor.test.tsx` (renders in **create** mode with `target=null`):

```ts
function renderNew(props: Partial<ComponentProps<typeof RoleEditor>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoleEditor target={null} open onClose={vi.fn()} onApply={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

test("preset seeds the rules and Apply builds them", () => {
  const onApply = vi.fn();
  renderNew({ onApply });
  fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Read-only" }));
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  const { yaml } = onApply.mock.calls[0][0];
  expect(yaml).toContain("verbs: ['get', 'list', 'watch']");
  expect(yaml).toContain("resources: ['*']");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test RoleEditor`
Expected: FAIL — no "Read-only" button.

- [ ] **Step 3: Implement presets**

In `RoleEditor.tsx`, add the presets table below `verbSuggestionsForResources`:

```ts
export const ROLE_PRESETS: { id: string; label: string; rules: PolicyRule[] }[] = [
  { id: "read-only", label: "Read-only", rules: [
    { apiGroups: ["*"], resources: ["*"], verbs: ["get", "list", "watch"] },
  ] },
  { id: "namespace-admin", label: "Namespace admin", rules: [
    { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
  ] },
  { id: "deployer", label: "Deployer", rules: [
    { apiGroups: ["apps"], resources: ["deployments", "replicasets", "statefulsets", "daemonsets"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
    { apiGroups: [""], resources: ["pods", "services", "configmaps", "secrets"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
  ] },
];

function cloneRules(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((r) => ({
    apiGroups: [...(r.apiGroups ?? [])],
    resources: [...(r.resources ?? [])],
    verbs: [...(r.verbs ?? [])],
  }));
}
```

Add preset state (near the other `useState`s):

```ts
const [preset, setPreset] = useState<string | null>(null);
```

Make `setRule` clear the active preset (manual edit invalidates the preset highlight):

```ts
function setRule(i: number, patch: Partial<PolicyRule>) {
  setPreset(null);
  setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
}
```

Also call `setPreset(null)` in the "Add rule" and "Remove rule" onClick handlers (add it before the existing `setRules(...)`).

Render the preset row in create mode, immediately before `<SectionHeader label="RULES" ... />`:

```tsx
{!isEdit && (
  <div className="flex flex-col gap-[8px]">
    <span
      className="font-[var(--font-mono)] text-[10.5px] uppercase tracking-[0.8px]"
      style={{ color: "#6B6B73" }}
    >
      Preset
    </span>
    <div className="flex flex-wrap gap-[7px]">
      {ROLE_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => {
            setPreset(p.id);
            setRules(cloneRules(p.rules));
          }}
          className="rounded-[6px] border px-[12px] py-[6px] text-[13px] font-semibold"
          style={
            preset === p.id
              ? { borderColor: "#38BDF8", color: "#38BDF8", background: "#38BDF814" }
              : { borderColor: "#26272B", color: "#A1A1AA", background: "#FFFFFF05" }
          }
        >
          {p.label}
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test RoleEditor`
Expected: PASS. Then `pnpm --filter web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/RoleEditor.tsx apps/web/src/panels/rbac/components/RoleEditor.test.tsx
git commit -m "feat(rbac): starter role presets in the New role dialog (HELM-84)"
```

---

## Task 4: Server — `auth can-i` engine + route (HELM-85)

**Files:**
- Create: `apps/server/src/rbacCanI.ts`
- Create: `apps/server/src/rbacCanI.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/rbacCanI.test.ts`:

```ts
import { test, expect, vi } from "vitest";
import { impersonationArgs, resourceArg, runCanI } from "./rbacCanI";

test("impersonationArgs: ServiceAccount / User / Group", () => {
  expect(impersonationArgs({ kind: "ServiceAccount", name: "deployer", namespace: "prod" }))
    .toEqual(["--as=system:serviceaccount:prod:deployer"]);
  expect(impersonationArgs({ kind: "User", name: "alice" })).toEqual(["--as=alice"]);
  expect(impersonationArgs({ kind: "Group", name: "devs" }))
    .toEqual(["--as=rigel:can-i-probe", "--as-group=devs"]);
});

test("resourceArg: grouped resource uses resource.group; core/'*' bare", () => {
  expect(resourceArg({ verb: "get", resource: "deployments", apiGroup: "apps" })).toBe("deployments.apps");
  expect(resourceArg({ verb: "get", resource: "pods", apiGroup: "" })).toBe("pods");
  expect(resourceArg({ verb: "*", resource: "*", apiGroup: "*" })).toBe("*");
});

test("runCanI: maps yes/no/unknown and namespace flag", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: "yes\n", stderr: "" })
    .mockResolvedValueOnce({ code: 1, stdout: "no\n", stderr: "" });
  const { results, note } = await runCanI(
    { kind: "ServiceAccount", name: "sa", namespace: "default" },
    [
      { verb: "get", resource: "pods", apiGroup: "", namespace: "default" },
      { verb: "create", resource: "deployments", apiGroup: "apps" },
    ],
    run,
  );
  expect(results.map((r) => r.allowed)).toEqual([true, false]);
  expect(run).toHaveBeenNthCalledWith(1, [
    "auth", "can-i", "get", "pods", "--as=system:serviceaccount:default:sa", "-n", "default",
  ]);
  expect(note).toBeUndefined();
});

test("runCanI: impersonation-forbidden → allowed null + note", async () => {
  const run = vi.fn().mockResolvedValue({
    code: 1, stdout: "", stderr: 'Error from server (Forbidden): users "me" cannot impersonate resource "serviceaccounts"',
  });
  const { results, note } = await runCanI(
    { kind: "ServiceAccount", name: "sa", namespace: "default" },
    [{ verb: "get", resource: "pods", apiGroup: "" }],
    run,
  );
  expect(results[0].allowed).toBeNull();
  expect(note).toMatch(/impersonate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test rbacCanI`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `apps/server/src/rbacCanI.ts`:

```ts
// Runs `kubectl auth can-i` impersonating a subject, for the RBAC panel's
// inline access test. Read-only (can-i is a non-mutating verb), so it uses the
// plain kubectl runner and needs no confirm gate.

export interface Subject { kind?: string; name?: string; namespace?: string }
export interface CanICheck { verb: string; resource: string; apiGroup?: string; namespace?: string }
export interface CanIResult extends CanICheck { allowed: boolean | null }

type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function impersonationArgs(subject: Subject): string[] {
  const kind = subject.kind ?? "ServiceAccount";
  const name = subject.name ?? "";
  if (kind === "ServiceAccount") {
    return [`--as=system:serviceaccount:${subject.namespace ?? "default"}:${name}`];
  }
  if (kind === "Group") {
    // kubectl requires a --as user alongside --as-group; a synthetic username in
    // the target group yields the group's effective access.
    return ["--as=rigel:can-i-probe", `--as-group=${name}`];
  }
  return [`--as=${name}`];
}

export function resourceArg(check: CanICheck): string {
  const g = check.apiGroup;
  if (g && g !== "" && g !== "*") return `${check.resource}.${g}`;
  return check.resource;
}

function parseAllowed(stdout: string): boolean | null {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === "yes") return true;
  if (last === "no") return false;
  return null;
}

export async function runCanI(
  subject: Subject,
  checks: CanICheck[],
  run: Run,
): Promise<{ results: CanIResult[]; note?: string }> {
  const asArgs = impersonationArgs(subject);
  const results: CanIResult[] = [];
  let note: string | undefined;
  for (const check of checks) {
    const args = ["auth", "can-i", check.verb, resourceArg(check), ...asArgs];
    if (check.namespace) args.push("-n", check.namespace);
    const r = await run(args);
    const allowed = parseAllowed(r.stdout);
    if (allowed === null && /cannot impersonate|forbidden/i.test(r.stderr)) {
      note = "Could not impersonate the subject — your kubeconfig may lack impersonate permission.";
    }
    results.push({ ...check, allowed });
  }
  return { results, note };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/server test rbacCanI`
Expected: PASS.

- [ ] **Step 5: Add the route**

In `apps/server/src/index.ts`, add an import near the other route imports (e.g. beside `getApiResources`):

```ts
import { runCanI, type Subject, type CanICheck, type CanIResult } from "./rbacCanI";
```

Add the route immediately after the `/api/api-resources` block (after line 539). `kubectl` and `context` are already in scope in this handler:

```ts
    // POST /api/rbac/can-i — impersonated `kubectl auth can-i` for the RBAC
    // panel's inline access test. Read-only; no confirm gate.
    if (url.pathname === "/api/rbac/can-i" && req.method === "POST") {
      let subjects: Subject[] = [];
      let checks: CanICheck[] = [];
      try {
        const body = (await req.json()) as { subjects?: Subject[]; checks?: CanICheck[] };
        subjects = body.subjects ?? [];
        checks = body.checks ?? [];
      } catch {
        // empty/invalid body → empty result
      }
      const run = (args: string[]) => kubectl(context, args);
      const results: Array<{ subject: Subject; checks: CanIResult[] }> = [];
      let note: string | undefined;
      for (const subject of subjects) {
        const r = await runCanI(subject, checks, run);
        if (r.note) note = r.note;
        results.push({ subject, checks: r.results });
      }
      return Response.json({ results, note });
    }
```

- [ ] **Step 6: Run server test suite + typecheck**

Run: `pnpm --filter @rigel/server test rbacCanI && pnpm --filter @rigel/server build`
Expected: PASS + clean build (route typechecks).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/rbacCanI.ts apps/server/src/rbacCanI.test.ts apps/server/src/index.ts
git commit -m "feat(server): POST /api/rbac/can-i impersonated access test (HELM-85)"
```

---

## Task 5: Client — checks builder, fetch helper, AccessTest widget (HELM-85)

**Files:**
- Create: `apps/web/src/panels/rbac/canI.ts`
- Create: `apps/web/src/panels/rbac/canI.test.ts`
- Modify: `apps/web/src/lib/api.ts` (`postCanICheck`)
- Create: `apps/web/src/panels/rbac/components/AccessTest.tsx`

- [ ] **Step 1: Write the failing test for `rulesToChecks`**

Create `apps/web/src/panels/rbac/canI.test.ts`:

```ts
import { test, expect } from "vitest";
import { rulesToChecks } from "./canI";

test("rulesToChecks: expands rules to deduped verb×resource checks", () => {
  const checks = rulesToChecks(
    [
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "create"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get"] },
    ],
    "prod",
  );
  expect(checks).toEqual([
    { verb: "get", resource: "deployments", apiGroup: "apps", namespace: "prod" },
    { verb: "create", resource: "deployments", apiGroup: "apps", namespace: "prod" },
    { verb: "get", resource: "pods", apiGroup: "", namespace: "prod" },
  ]);
});

test("rulesToChecks: dedupes repeats and caps the count", () => {
  const rule = { apiGroups: [""], resources: ["pods"], verbs: ["get", "get", "list"] };
  expect(rulesToChecks([rule, rule])).toHaveLength(2);
  const big = { apiGroups: [""], resources: Array.from({ length: 40 }, (_, i) => `r${i}`), verbs: ["get"] };
  expect(rulesToChecks([big], undefined, 24)).toHaveLength(24);
});

test("rulesToChecks: keeps '*' verb/resource entries", () => {
  expect(rulesToChecks([{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]))
    .toEqual([{ verb: "*", resource: "*", apiGroup: "*", namespace: undefined }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test canI`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `canI.ts`**

Create `apps/web/src/panels/rbac/canI.ts`:

```ts
import type { PolicyRule } from "./types";

export interface CanICheck { verb: string; resource: string; apiGroup?: string; namespace?: string }
export interface CanIResult extends CanICheck { allowed: boolean | null }

/** Expand a role's rules into deduped, capped `can-i` checks (first apiGroup per
 *  rule). Keeps `*` entries — `can-i '*' '*'` is valid and meaningful. */
export function rulesToChecks(rules: PolicyRule[], namespace?: string, cap = 24): CanICheck[] {
  const seen = new Set<string>();
  const checks: CanICheck[] = [];
  for (const rule of rules) {
    const apiGroup = rule.apiGroups?.length ? rule.apiGroups[0] : "";
    for (const resource of rule.resources ?? []) {
      for (const verb of rule.verbs ?? []) {
        const key = `${verb} ${resource} ${apiGroup}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ verb, resource, apiGroup, namespace });
        if (checks.length >= cap) return checks;
      }
    }
  }
  return checks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test canI`
Expected: PASS.

- [ ] **Step 5: Add the fetch helper**

In `apps/web/src/lib/api.ts`, import the types and add the helper (place near the api-resources block). Add to the existing rbac-types import from the panel, or add a new import:

```ts
import type { Subject } from "@/panels/rbac/types";
import type { CanICheck, CanIResult } from "@/panels/rbac/canI";
```

```ts
export interface CanIResponse {
  results: Array<{ subject: Subject; checks: CanIResult[] }>;
  note?: string;
}

/** Impersonated `kubectl auth can-i` for the RBAC access test (read-only). */
export async function postCanICheck(subjects: Subject[], checks: CanICheck[]): Promise<CanIResponse> {
  const res = await apiFetch("/api/rbac/can-i", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subjects, checks }),
  });
  if (!res.ok) throw new Error(`Access test failed: ${res.status}`);
  return (await res.json()) as CanIResponse;
}
```

- [ ] **Step 6: Implement the `AccessTest` widget**

Create `apps/web/src/panels/rbac/components/AccessTest.tsx`:

```tsx
import { useState } from "react";
import { Check, X, HelpCircle, ShieldCheck, Loader2 } from "lucide-react";
import type { Subject } from "../types";
import type { CanICheck, CanIResult } from "../canI";
import { postCanICheck } from "@/lib/api";

interface Props {
  subject: Subject;
  checks: CanICheck[];
}

/** A per-subject "Test access" trigger that runs impersonated `can-i` against a
 *  set of checks and lists ✓ already-allowed / ✗ granted-by-this-binding / ?
 *  unknown per check. Shared by the New binding dialog and Role detail view. */
export function AccessTest({ subject, checks }: Props) {
  const [results, setResults] = useState<CanIResult[] | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = loading || checks.length === 0 || !(subject.name ?? "").trim();

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await postCanICheck([subject], checks);
      setResults(r.results[0]?.checks ?? []);
      setNote(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to test access");
    } finally {
      setLoading(false);
    }
  }

  const label = subject.kind === "ServiceAccount" && subject.namespace
    ? `${subject.namespace}:${subject.name}`
    : subject.name ?? "";

  return (
    <div className="flex flex-col gap-[7px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[12px] py-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 break-all font-[var(--font-mono)] text-xs text-[var(--fg-secondary)]">
          {subject.kind ?? "ServiceAccount"} · {label || "—"}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-[10px] py-[5px] text-xs font-medium text-[var(--fg-primary)] transition-colors hover:bg-white/[0.06] disabled:opacity-40"
        >
          {loading ? <Loader2 className="size-[13px] animate-spin" /> : <ShieldCheck className="size-[13px]" />}
          Test access
        </button>
      </div>

      {error && <span className="text-2xs text-[var(--status-failed)]">{error}</span>}
      {note && <span className="text-2xs text-[var(--fg-tertiary)]">{note}</span>}

      {results && results.length > 0 && (
        <div className="flex flex-col gap-[3px]">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-[8px] font-[var(--font-mono)] text-2xs">
              {r.allowed === true ? (
                <Check className="size-[13px] shrink-0 text-[var(--status-ok,#4ADE80)]" />
              ) : r.allowed === false ? (
                <X className="size-[13px] shrink-0 text-[var(--fg-tertiary)]" />
              ) : (
                <HelpCircle className="size-[13px] shrink-0 text-[var(--fg-tertiary)]" />
              )}
              <span className="text-[var(--fg-secondary)]">
                {r.verb} {r.resource}
                {r.apiGroup && r.apiGroup !== "" ? `.${r.apiGroup}` : ""}
              </span>
              <span className="text-[var(--fg-tertiary)]">
                {r.allowed === true ? "already allowed" : r.allowed === false ? "→ granted by this role" : "unknown"}
              </span>
            </div>
          ))}
        </div>
      )}
      {results && results.length === 0 && (
        <span className="text-2xs text-[var(--fg-tertiary)]">This role grants no testable rules.</span>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/panels/rbac/canI.ts apps/web/src/panels/rbac/canI.test.ts apps/web/src/lib/api.ts apps/web/src/panels/rbac/components/AccessTest.tsx
git commit -m "feat(rbac): access-test checks builder, fetch helper, and AccessTest widget (HELM-85)"
```

---

## Task 6: Wire AccessTest into BindingEditor, RoleDetail, RbacPanel (HELM-85)

**Files:**
- Modify: `apps/web/src/panels/rbac/components/BindingEditor.tsx`
- Modify: `apps/web/src/panels/rbac/components/RoleDetail.tsx`
- Modify: `apps/web/src/panels/rbac/RbacPanel.tsx`
- Test: `apps/web/src/panels/rbac/components/BindingEditor.test.tsx`

- [ ] **Step 1: BindingEditor — add `rulesForRole` prop + TEST ACCESS section**

In `BindingEditor.tsx`, add imports:

```ts
import { AccessTest } from "./AccessTest";
import { rulesToChecks } from "../canI";
import type { PolicyRule } from "../types";
```

Add to `Props`:

```ts
  /** Resolve the granted role's rules, so the access test knows what to probe. */
  rulesForRole?: (kind: "Role" | "ClusterRole", name: string, namespace?: string) => PolicyRule[];
```

Destructure `rulesForRole` in the component signature. Then render a TEST ACCESS section after the "Add subject" button (still inside `DialogBody`):

```tsx
{rulesForRole && (roleRef.name ?? "").trim() && subjects.some((s) => (s.name ?? "").trim()) && (
  <>
    <SectionHeader label="TEST ACCESS" />
    <span className="text-[12px]" style={{ color: "#6B6B73" }}>
      Impersonates each subject to check what the granted role adds.
    </span>
    {subjects
      .filter((s) => (s.name ?? "").trim())
      .map((s, i) => (
        <AccessTest
          key={i}
          subject={s}
          checks={rulesToChecks(
            rulesForRole((roleRef.kind as "Role" | "ClusterRole") ?? "Role", roleRef.name ?? "", namespace),
            kind === "RoleBinding" ? namespace : undefined,
          )}
        />
      ))}
  </>
)}
```

- [ ] **Step 2: RbacPanel — supply `rulesForRole`**

In `RbacPanel.tsx`, the `<BindingEditor ... />` already has `roleOptions`. Add the prop (uses the already-imported `resolveRoleRules`):

```tsx
rulesForRole={(kind, name, ns) =>
  resolveRoleRules({ kind, name }, ns, roles, clusterRoles)
}
```

- [ ] **Step 3: RoleDetail — per-subject test in the Bound-to list**

In `RoleDetail.tsx`, add imports:

```ts
import { AccessTest } from "./AccessTest";
import { rulesToChecks } from "../canI";
```

The component already receives `rules` and `boundSubjects`. Inside the `boundSubjects.map(...)`, below the existing subject label row (after the closing tags of the name/kind spans, still inside the row's wrapping `<div>`), append an `AccessTest`:

```tsx
<div className="w-full">
  <AccessTest
    subject={b.subject}
    checks={rulesToChecks(rules, b.scope.kind === "Namespaced" ? b.scope.namespace : undefined)}
  />
</div>
```

(Change the row wrapper's classes so the AccessTest sits on its own line — the existing row is `flex flex-wrap items-center`; adding a `w-full` child wraps it beneath the label. Keep the existing label spans intact.)

- [ ] **Step 4: Write the failing test for the binding wiring**

Add to `apps/web/src/panels/rbac/components/BindingEditor.test.tsx` (create the `fetch` stub if the file doesn't already have one — mirror RoleEditor's `beforeEach`/`afterEach`). Test that a subject + role renders a Test-access button and calls the endpoint:

```ts
test("renders a per-subject access test when a role and subject are set", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/api/rbac/can-i")) {
      return new Response(JSON.stringify({
        results: [{ subject: { kind: "ServiceAccount", name: "sa", namespace: "default" }, checks: [
          { verb: "get", resource: "pods", apiGroup: "", allowed: false },
        ] }],
        note: undefined,
      }));
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <BindingEditor
      target={{
        kind: "RoleBinding", name: "rb", namespace: "default",
        roleRef: { kind: "Role", name: "reader" },
        subjects: [{ kind: "ServiceAccount", name: "sa", namespace: "default" }],
      }}
      open
      onClose={vi.fn()}
      onApply={vi.fn()}
      rulesForRole={() => [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }]}
    />,
  );

  const btn = screen.getAllByRole("button", { name: /Test access/ })[0];
  fireEvent.click(btn);
  expect(await screen.findByText(/granted by this role/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/rbac/can-i", expect.objectContaining({ method: "POST" }));
});
```

(Import `render, screen, fireEvent, cleanup` from `@testing-library/react` and `vi, test, expect, afterEach` from vitest at the top if not present; add `afterEach(() => { cleanup(); vi.unstubAllGlobals(); })`.)

- [ ] **Step 5: Run test to verify it fails, then passes**

Run: `pnpm --filter web test BindingEditor`
Expected: FAIL first (no Test-access button) → after Steps 1-3 are in place, PASS.

- [ ] **Step 6: Full typecheck + rbac test sweep**

Run: `pnpm --filter web typecheck && pnpm --filter web test rbac && pnpm --filter @rigel/server test`
Expected: all PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/rbac/components/BindingEditor.tsx apps/web/src/panels/rbac/components/RoleDetail.tsx apps/web/src/panels/rbac/RbacPanel.tsx apps/web/src/panels/rbac/components/BindingEditor.test.tsx
git commit -m "feat(rbac): inline can-i access test in binding dialog & role detail (HELM-85)"
```

---

## Final verification

- [ ] `pnpm --filter web typecheck` — clean
- [ ] `pnpm --filter web test` — all pass
- [ ] `pnpm --filter @rigel/server test` — all pass
- [ ] `pnpm --filter @rigel/server build` — clean
- [ ] Manual smoke via `pnpm --filter desktop dev` (only if asked): New role → pick Deployer preset → verbs narrow to picked resources; New binding → set role + subject → Test access lists ✓/✗; Role detail → Bound-to subject → Test access.

## Post-implementation (per user workflow)

- [ ] Update the RBAC Outline doc ("RBAC — access analyzer & role/binding editors"): move the three shipped ideas out of "Ideas / future" into the feature body.
- [ ] Move HELM-83/84/85 to Done in Plane.
