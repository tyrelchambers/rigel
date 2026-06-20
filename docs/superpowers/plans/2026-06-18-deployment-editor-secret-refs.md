# Deployment editor — image-pull secrets + env-from-secret/configmap refs + wide modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Deployment config editor attach registry/image-pull secrets and add env vars referenced from existing Secret/ConfigMap keys, presented in a wide centered modal.

**Architecture:** Two new web-only `ActionBlock` kinds (`setImagePullSecrets`, `setEnvRef`) map to `kubectl patch` in the server's `buildCommand`; command preview/confirm flow through the existing `/api/action?preview=1` → `BatchConfirmSheet` path unchanged. The web edit model/diff (`deploymentDisplay.ts`) grows deployment-level `imagePullSecrets` and per-container editable secret/configmap refs. Two new focused UI components surface them; the editor switches from a bottom `Sheet` to a centered `Dialog`.

**Tech Stack:** TypeScript, React 19, Vite, Tailwind v4, shadcn/ui (`dialog`), Zustand cluster store, vitest (web), bun test (server). Spec: `docs/superpowers/specs/2026-06-18-deployment-editor-secret-refs-design.md`.

---

## File structure

- **Modify** `apps/web/src/panels/deployments/types.ts` — type `EnvVar.valueFrom`; add `imagePullSecrets` to `PodTemplate.spec`.
- **Modify** `apps/web/src/lib/api.ts` — add `imagePullSecrets`, `envRefs` to client `ActionBlock`.
- **Modify** `apps/server/src/actions.ts` — add same fields to server `ActionBlock`; add `setImagePullSecrets` + `setEnvRef` cases to `buildCommand`.
- **Modify** `apps/server/src/actions.test.ts` — `buildCommand` tests for the two kinds.
- **Modify** `apps/web/src/panels/deployments/deploymentDisplay.ts` — `EnvRefEdit` type; `DeploymentEdit.imagePullSecrets`; `ContainerEdit.envRefs` + `otherRefKeys` (replaces `refEnvKeys`); `editModelFor` + `diffDeployment`.
- **Modify** `apps/web/src/panels/deployments/deploymentEdit.test.ts` — migrate the ref assertion; add imagePullSecrets/envRef diff tests.
- **Create** `apps/web/src/panels/deployments/EnvRefEditor.tsx` — per-container ref-row editor.
- **Create** `apps/web/src/panels/deployments/ImagePullSecretsField.tsx` — deployment-level registry-secret picker.
- **Modify** `apps/web/src/panels/deployments/DeploymentEditor.tsx` — wire both components, subscribe to secrets/configmaps, convert Sheet→Dialog.

**Test harness note:** vitest here runs **pure-logic** tests only (it imports `deploymentDisplay` + `types`, never the `.tsx` components), so model/diff and server `buildCommand` are TDD'd. The `.tsx` UI tasks are verified by `pnpm --filter web typecheck` + `build` + the final Docker run, not unit tests.

---

## Task 1: Type additions (additive, compiles standalone)

**Files:**
- Modify: `apps/web/src/panels/deployments/types.ts:7-12` (EnvVar), `:25-30` (PodTemplate)
- Modify: `apps/web/src/lib/api.ts:9-38` (ActionBlock)
- Modify: `apps/server/src/actions.ts:38-85` (ActionBlock)

- [ ] **Step 1: Type `EnvVar.valueFrom` and add `imagePullSecrets` to the pod template** in `types.ts`.

Replace the `EnvVar` interface:
```ts
export interface EnvKeyRef {
  name: string;
  key: string;
}

export interface EnvValueFrom {
  secretKeyRef?: EnvKeyRef;
  configMapKeyRef?: EnvKeyRef;
  fieldRef?: { fieldPath?: string };
  resourceFieldRef?: { resource?: string; containerName?: string };
}

export interface EnvVar {
  name: string;
  value?: string;
  /** Present for secret/configMap/field refs. When set, the value is not a plain string. */
  valueFrom?: EnvValueFrom;
}
```

In the `PodTemplate` interface, change the `spec` member to add `imagePullSecrets`:
```ts
export interface PodTemplate {
  metadata?: {
    labels?: Record<string, string>;
  };
  spec?: {
    containers: Container[];
    imagePullSecrets?: Array<{ name: string }>;
  };
}
```

- [ ] **Step 2: Add the two new fields to the client `ActionBlock`** in `apps/web/src/lib/api.ts`, immediately after the `content?: string;` line (the last field before the closing brace):

```ts
  /** setImagePullSecrets only — desired full list of imagePullSecret names. */
  imagePullSecrets?: string[];
  /** setEnvRef only — env vars sourced from a Secret/ConfigMap key. */
  envRefs?: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }>;
```

- [ ] **Step 3: Add the identical two fields to the server `ActionBlock`** in `apps/server/src/actions.ts`, immediately after the `content?: string;` line:

```ts
  /** setImagePullSecrets only — desired full list of imagePullSecret names. */
  imagePullSecrets?: string[];
  /** setEnvRef only — env vars sourced from a Secret/ConfigMap key. */
  envRefs?: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }>;
```

- [ ] **Step 4: Verify both packages still typecheck**

Run: `pnpm --filter web typecheck && pnpm --filter @rigel/server build`
Expected: PASS (additions only; no existing reference breaks).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/types.ts apps/web/src/lib/api.ts apps/server/src/actions.ts
git commit -m "feat(deploy-editor): add imagePullSecrets/envRefs ActionBlock fields and typed valueFrom"
```

---

## Task 2: Server `buildCommand` — `setImagePullSecrets` (TDD)

**Files:**
- Test: `apps/server/src/actions.test.ts`
- Modify: `apps/server/src/actions.ts` (new `case` in `buildCommand`)

- [ ] **Step 1: Write the failing test.** Append to `apps/server/src/actions.test.ts`:

```ts
// ---------------------------------------------------------------------------
// setImagePullSecrets
// ---------------------------------------------------------------------------
test("setImagePullSecrets patches the pod template imagePullSecrets array", () => {
  expect(
    buildCommand({ kind: "setImagePullSecrets", name: "web", namespace: "default", imagePullSecrets: ["ghcr-secret"] }),
  ).toEqual([
    "patch", "deployment/web", "-n", "default", "--type=merge",
    "-p", '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr-secret"}]}}}}',
  ]);
});

test("setImagePullSecrets with empty list clears the array", () => {
  expect(
    buildCommand({ kind: "setImagePullSecrets", name: "web", namespace: "default", imagePullSecrets: [] }),
  ).toEqual([
    "patch", "deployment/web", "-n", "default", "--type=merge",
    "-p", '{"spec":{"template":{"spec":{"imagePullSecrets":[]}}}}',
  ]);
});

test("setImagePullSecrets honors resourceKind", () => {
  expect(
    buildCommand({ kind: "setImagePullSecrets", name: "pg", namespace: "db", imagePullSecrets: ["reg"], resourceKind: "statefulset" }),
  ).toEqual([
    "patch", "statefulset/pg", "-n", "db", "--type=merge",
    "-p", '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"reg"}]}}}}',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rigel/server test 2>&1 | grep -A2 setImagePullSecrets`
Expected: FAIL — `unsupported action kind: setImagePullSecrets`.

- [ ] **Step 3: Implement the case.** In `apps/server/src/actions.ts`, add inside the `switch (a.kind)` in `buildCommand`, right before the `case "command":` block:

```ts
    // -----------------------------------------------------------------------
    // setImagePullSecrets — patch spec.template.spec.imagePullSecrets (full
    // desired list). JSON merge patch replaces the array, so detach/clear works
    // by sending a shorter list or []. (docs/superpowers/specs/2026-06-18-…)
    // -----------------------------------------------------------------------
    case "setImagePullSecrets": {
      const wk = workloadKind(a);
      const list = (a.imagePullSecrets ?? []).map((n) => ({ name: n }));
      const patch = JSON.stringify({ spec: { template: { spec: { imagePullSecrets: list } } } });
      return ["patch", `${wk}/${target(a)}`, ...ns, "--type=merge", "-p", patch];
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rigel/server test 2>&1 | tail -5`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/actions.ts apps/server/src/actions.test.ts
git commit -m "feat(server): setImagePullSecrets action → kubectl patch --type=merge"
```

---

## Task 3: Server `buildCommand` — `setEnvRef` (TDD)

**Files:**
- Test: `apps/server/src/actions.test.ts`
- Modify: `apps/server/src/actions.ts`

- [ ] **Step 1: Write the failing test.** Append to `apps/server/src/actions.test.ts`:

```ts
// ---------------------------------------------------------------------------
// setEnvRef
// ---------------------------------------------------------------------------
test("setEnvRef patches a secretKeyRef env var via strategic merge", () => {
  expect(
    buildCommand({
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [{ name: "DB_PASSWORD", source: "secret", resourceName: "app-db", key: "password" }],
    }),
  ).toEqual([
    "patch", "deployment/web", "-n", "default", "--type=strategic",
    "-p", '{"spec":{"template":{"spec":{"containers":[{"name":"app","env":[{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"app-db","key":"password"}}}]}]}}}}',
  ]);
});

test("setEnvRef supports configMapKeyRef and multiple refs", () => {
  expect(
    buildCommand({
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [
        { name: "LOG_LEVEL", source: "configMap", resourceName: "app-config", key: "log.level" },
        { name: "TOKEN", source: "secret", resourceName: "app-secrets", key: "token" },
      ],
    }),
  ).toEqual([
    "patch", "deployment/web", "-n", "default", "--type=strategic",
    "-p", '{"spec":{"template":{"spec":{"containers":[{"name":"app","env":[{"name":"LOG_LEVEL","valueFrom":{"configMapKeyRef":{"name":"app-config","key":"log.level"}}},{"name":"TOKEN","valueFrom":{"secretKeyRef":{"name":"app-secrets","key":"token"}}}]}]}}}}',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rigel/server test 2>&1 | grep -A2 setEnvRef`
Expected: FAIL — `unsupported action kind: setEnvRef`.

- [ ] **Step 3: Implement the case.** In `apps/server/src/actions.ts`, add directly below the `setImagePullSecrets` case:

```ts
    // -----------------------------------------------------------------------
    // setEnvRef — patch container env vars whose value comes from a Secret or
    // ConfigMap key. Strategic merge keys containers + env by `name`, so it
    // adds/updates only the referenced vars. (kubectl set env can't rename a
    // referenced key, hence the patch.)
    // -----------------------------------------------------------------------
    case "setEnvRef": {
      const wk = workloadKind(a);
      const env = (a.envRefs ?? []).map((r) => ({
        name: r.name,
        valueFrom: r.source === "configMap"
          ? { configMapKeyRef: { name: r.resourceName, key: r.key } }
          : { secretKeyRef: { name: r.resourceName, key: r.key } },
      }));
      const patch = JSON.stringify({ spec: { template: { spec: { containers: [{ name: a.container, env }] } } } });
      return ["patch", `${wk}/${target(a)}`, ...ns, "--type=strategic", "-p", patch];
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rigel/server test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/actions.ts apps/server/src/actions.test.ts
git commit -m "feat(server): setEnvRef action → kubectl patch --type=strategic (secret/configMap key refs)"
```

---

## Task 4: Edit model — split refs + imagePullSecrets (TDD)

**Files:**
- Test: `apps/web/src/panels/deployments/deploymentEdit.test.ts`
- Modify: `apps/web/src/panels/deployments/deploymentDisplay.ts:234-276`
- Modify: `apps/web/src/panels/deployments/DeploymentEditor.tsx:170-186` (rename `refEnvKeys`→`otherRefKeys` to keep compile green; full UI in Tasks 7–9)

- [ ] **Step 1: Migrate the existing model test + add an imagePullSecrets case.** In `deploymentEdit.test.ts`, replace the `editModelFor splits plain vs ref env…` test body's two ref assertions, and extend `dep()` with imagePullSecrets. First, edit `dep()` to add image pull secrets to the pod spec (inside `spec.template.spec`, after `containers`):

```ts
          imagePullSecrets: [{ name: "ghcr-secret" }],
```

Then replace the last two lines of the `editModelFor splits…` test:
```ts
  expect(m.containers[0].env).toEqual([{ id: "LOG_LEVEL", key: "LOG_LEVEL", value: "info" }]);
  expect(m.containers[0].refEnvKeys).toEqual(["DB_PASS"]);
```
with:
```ts
  expect(m.containers[0].env).toEqual([{ id: "LOG_LEVEL", key: "LOG_LEVEL", value: "info" }]);
  expect(m.containers[0].envRefs).toEqual([
    { id: "DB_PASS", name: "DB_PASS", source: "secret", resourceName: "db", key: "pass" },
  ]);
  expect(m.containers[0].otherRefKeys).toEqual([]);
  expect(m.imagePullSecrets).toEqual(["ghcr-secret"]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -20`
Expected: FAIL — `envRefs`/`otherRefKeys`/`imagePullSecrets` undefined.

- [ ] **Step 3: Update the edit-model types + `editModelFor`** in `deploymentDisplay.ts`. Replace the `EnvEdit`/`ContainerEdit`/`DeploymentEdit` block (the interfaces starting at `export interface EnvEdit`) with:

```ts
/** One editable env row (plain string value only). */
export interface EnvEdit { id: string; key: string; value: string }

/** One editable env-from-resource row (Secret/ConfigMap key reference). */
export interface EnvRefEdit {
  id: string;
  name: string;
  source: "secret" | "configMap";
  resourceName: string;
  key: string;
}

/** Editable view of a single container. */
export interface ContainerEdit {
  name: string;
  image: string;
  cpuReq: string;
  cpuLim: string;
  memReq: string;
  memLim: string;
  /** Editable plain-value env vars. */
  env: EnvEdit[];
  /** Editable env vars sourced from a Secret/ConfigMap key. */
  envRefs: EnvRefEdit[];
  /** Names of non-secret/non-configmap valueFrom env vars (fieldRef/resourceFieldRef): read-only, removable. */
  otherRefKeys: string[];
}

/** Editable view of a whole deployment. */
export interface DeploymentEdit {
  replicas: number;
  /** Pod-level imagePullSecret names (private registry auth, e.g. GHCR). */
  imagePullSecrets: string[];
  containers: ContainerEdit[];
}
```

Then replace `editModelFor` with:
```ts
/** Build the mutable edit model from a deployment's live spec. */
export function editModelFor(d: Deployment): DeploymentEdit {
  const containers = d.spec?.template?.spec?.containers ?? [];
  return {
    replicas: desiredReplicas(d),
    imagePullSecrets: (d.spec?.template?.spec?.imagePullSecrets ?? []).map((s) => s.name),
    containers: containers.map((c) => {
      const env = c.env ?? [];
      const envRefs: EnvRefEdit[] = [];
      const otherRefKeys: string[] = [];
      for (const e of env) {
        const vf = e.valueFrom;
        if (vf?.secretKeyRef) {
          envRefs.push({ id: e.name, name: e.name, source: "secret", resourceName: vf.secretKeyRef.name, key: vf.secretKeyRef.key });
        } else if (vf?.configMapKeyRef) {
          envRefs.push({ id: e.name, name: e.name, source: "configMap", resourceName: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key });
        } else if (vf != null) {
          otherRefKeys.push(e.name);
        }
      }
      return {
        name: c.name,
        image: c.image ?? "",
        cpuReq: c.resources?.requests?.cpu ?? "",
        cpuLim: c.resources?.limits?.cpu ?? "",
        memReq: c.resources?.requests?.memory ?? "",
        memLim: c.resources?.limits?.memory ?? "",
        env: env.filter((e) => e.valueFrom == null).map((e) => ({ id: e.name, key: e.name, value: e.value ?? "" })),
        envRefs,
        otherRefKeys,
      };
    }),
  };
}
```

- [ ] **Step 4: Keep `DeploymentEditor.tsx` compiling** by renaming its read-only ref block from `refEnvKeys` to `otherRefKeys`. In `DeploymentEditor.tsx`, in the block that currently reads `c.refEnvKeys.length > 0 && (…)`, replace every `c.refEnvKeys` with `c.otherRefKeys` (4 occurrences: the `.length` guard, the `.map`, the `updateContainer(ci, { refEnvKeys: … })`, and the `.filter`). The replacement for the `updateContainer` call is:
```tsx
                              onClick={() => updateContainer(ci, { otherRefKeys: c.otherRefKeys.filter((x) => x !== k) })}
```

- [ ] **Step 5: Run model test + typecheck**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -10 && pnpm --filter web typecheck`
Expected: model test PASS; typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/deployments/deploymentDisplay.ts apps/web/src/panels/deployments/deploymentEdit.test.ts apps/web/src/panels/deployments/DeploymentEditor.tsx
git commit -m "feat(deploy-editor): edit model gains imagePullSecrets + editable secret/configmap env refs"
```

---

## Task 5: Diff — `setImagePullSecrets` (TDD)

**Files:**
- Test: `apps/web/src/panels/deployments/deploymentEdit.test.ts`
- Modify: `apps/web/src/panels/deployments/deploymentDisplay.ts` (`diffDeployment`)

- [ ] **Step 1: Write the failing tests.** Append to `deploymentEdit.test.ts`:

```ts
test("diffDeployment emits setImagePullSecrets when the list changes", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.imagePullSecrets = ["ghcr-secret", "dockerhub"];
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setImagePullSecrets", name: "web", namespace: "default",
      imagePullSecrets: ["ghcr-secret", "dockerhub"],
      label: "Set image pull secrets: ghcr-secret, dockerhub",
    },
  ]);
});

test("diffDeployment ignores image-pull-secret reordering (set comparison)", () => {
  const original = dep();
  const edit = editModelFor(original); // ["ghcr-secret"]
  edit.imagePullSecrets = ["ghcr-secret"];
  expect(diffDeployment(original, edit)).toEqual([]);
});

test("diffDeployment emits a clear label when image pull secrets are removed", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.imagePullSecrets = [];
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "setImagePullSecrets", name: "web", namespace: "default", imagePullSecrets: [], label: "Clear image pull secrets" },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -20`
Expected: FAIL — no `setImagePullSecrets` action emitted.

- [ ] **Step 3: Implement the diff.** In `deploymentDisplay.ts`, inside `diffDeployment`, add this block **after** the `for (const c of edit.containers) { … }` loop and **before** `return actions;`:

```ts
  // imagePullSecrets — order-insensitive set comparison; emit the full desired list.
  const origIPS = (original.spec?.template?.spec?.imagePullSecrets ?? []).map((s) => s.name);
  const editIPS = edit.imagePullSecrets;
  const ipsChanged =
    origIPS.length !== editIPS.length ||
    [...origIPS].sort().join(" ") !== [...editIPS].sort().join(" ");
  if (ipsChanged) {
    actions.push({
      kind: "setImagePullSecrets",
      name,
      namespace,
      imagePullSecrets: editIPS,
      label: editIPS.length ? `Set image pull secrets: ${editIPS.join(", ")}` : "Clear image pull secrets",
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/deploymentDisplay.ts apps/web/src/panels/deployments/deploymentEdit.test.ts
git commit -m "feat(deploy-editor): diff imagePullSecrets → setImagePullSecrets action"
```

---

## Task 6: Diff — `setEnvRef` + ref removal + plain→ref ordering (TDD)

**Files:**
- Test: `apps/web/src/panels/deployments/deploymentEdit.test.ts`
- Modify: `apps/web/src/panels/deployments/deploymentDisplay.ts` (`diffDeployment` env block)

- [ ] **Step 1: Write the failing tests.** Append to `deploymentEdit.test.ts`:

```ts
test("diffDeployment emits setEnvRef when a new secret ref is added", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs.push({ id: "API_KEY", name: "API_KEY", source: "secret", resourceName: "api", key: "key" });
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [{ name: "API_KEY", source: "secret", resourceName: "api", key: "key" }],
      label: "Reference secrets/config in app environment",
    },
  ]);
});

test("diffDeployment skips incomplete env ref rows", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs.push({ id: "X", name: "X", source: "secret", resourceName: "", key: "" });
  expect(diffDeployment(original, edit)).toEqual([]);
});

test("diffDeployment unsets an env var when its ref is removed", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs = []; // removes DB_PASS (a secretKeyRef)
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setEnv", name: "web", namespace: "default", container: "app",
      unsetEnv: ["DB_PASS"], label: "Update app environment",
    },
  ]);
});

test("diffDeployment converting a plain var to a ref unsets then setEnvRefs, in order", () => {
  const original = dep();
  const edit = editModelFor(original);
  // move LOG_LEVEL from plain to a configmap ref
  edit.containers[0].env = [];
  edit.containers[0].envRefs.push({ id: "LOG_LEVEL", name: "LOG_LEVEL", source: "configMap", resourceName: "cfg", key: "level" });
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "setEnv", name: "web", namespace: "default", container: "app", unsetEnv: ["LOG_LEVEL"], label: "Update app environment" },
    {
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [{ name: "LOG_LEVEL", source: "configMap", resourceName: "cfg", key: "level" }],
      label: "Reference secrets/config in app environment",
    },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -25`
Expected: FAIL — `setEnvRef` not emitted; removal test still references old `refEnvKeys` logic.

- [ ] **Step 3: Implement the env-ref diff.** In `deploymentDisplay.ts`, replace the existing env-diff block inside the container loop (the section starting `// env diff: plain-value adds/edits + removals` through the `if (Object.keys(setEnv).length > 0 || removed.length > 0) { … }` push) with:

```ts
    // env diff — plain value adds/edits + removals, then secret/configMap refs.
    const origPlain = new Map((orig.env ?? []).filter((e) => e.valueFrom == null).map((e) => [e.name, e.value ?? ""] as const));
    const origRefKeys = (orig.env ?? []).filter((e) => e.valueFrom != null).map((e) => e.name);
    const setEnv: Record<string, string> = {};
    for (const row of c.env) {
      if (!row.key) continue;
      if (origPlain.get(row.key) !== row.value) setEnv[row.key] = row.value;
    }
    const keptPlain = new Set(c.env.map((r) => r.key));
    const keptRefNames = new Set<string>([...c.envRefs.map((r) => r.name), ...c.otherRefKeys]);
    const removed: string[] = [];
    for (const k of origPlain.keys()) if (!keptPlain.has(k)) removed.push(k);
    for (const k of origRefKeys) if (!keptRefNames.has(k)) removed.push(k);

    // setEnv (plain adds/edits + removals) is pushed BEFORE setEnvRef so a
    // plain→ref conversion unsets the plain entry first (avoids value+valueFrom).
    if (Object.keys(setEnv).length > 0 || removed.length > 0) {
      const a: ActionBlock = { kind: "setEnv", name, namespace, container: c.name, label: `Update ${c.name} environment` };
      if (Object.keys(setEnv).length > 0) a.env = setEnv;
      if (removed.length > 0) a.unsetEnv = removed.sort();
      actions.push(a);
    }

    // secret/configMap key refs — emit added/changed ones as one strategic patch.
    const origRefs = new Map<string, { source: "secret" | "configMap"; resourceName: string; key: string }>();
    for (const e of orig.env ?? []) {
      const vf = e.valueFrom;
      if (vf?.secretKeyRef) origRefs.set(e.name, { source: "secret", resourceName: vf.secretKeyRef.name, key: vf.secretKeyRef.key });
      else if (vf?.configMapKeyRef) origRefs.set(e.name, { source: "configMap", resourceName: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key });
    }
    const envRefsOut: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }> = [];
    for (const r of c.envRefs) {
      if (!r.name || !r.resourceName || !r.key) continue; // skip incomplete rows
      const o = origRefs.get(r.name);
      if (!o || o.source !== r.source || o.resourceName !== r.resourceName || o.key !== r.key) {
        envRefsOut.push({ name: r.name, source: r.source, resourceName: r.resourceName, key: r.key });
      }
    }
    if (envRefsOut.length > 0) {
      actions.push({ kind: "setEnvRef", name, namespace, container: c.name, envRefs: envRefsOut, label: `Reference secrets/config in ${c.name} environment` });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test deploymentEdit 2>&1 | tail -12`
Expected: PASS (all deploymentEdit tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/deploymentDisplay.ts apps/web/src/panels/deployments/deploymentEdit.test.ts
git commit -m "feat(deploy-editor): diff secret/configmap env refs → setEnvRef (+ removal & plain→ref ordering)"
```

---

## Task 7: `EnvRefEditor` component + wire into the editor

**Files:**
- Create: `apps/web/src/panels/deployments/EnvRefEditor.tsx`
- Modify: `apps/web/src/panels/deployments/DeploymentEditor.tsx`

- [ ] **Step 1: Create `EnvRefEditor.tsx`** with this exact content:

```tsx
import { Plus, Minus } from "lucide-react";
import type { Secret, ConfigMap } from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import type { EnvRefEdit } from "./deploymentDisplay";

// ---------------------------------------------------------------------------
// EnvRefEditor — per-container editor for env vars sourced from a Secret or
// ConfigMap key (valueFrom.{secretKeyRef|configMapKeyRef}). Each row: env name,
// source toggle, resource picker (live from the namespace), and key picker
// (keys read from the chosen resource's `data`). Mirrors Rancher's
// "Add Variable → From Resource". Rows are keyed by stable ids so a keystroke
// doesn't steal focus. Diffed by `diffDeployment` into a `setEnvRef` patch.
// ---------------------------------------------------------------------------

const inputClass =
  "rounded-md border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-ring";
const selectClass =
  "rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

let refSeq = 0;
function blankRef(): EnvRefEdit {
  return { id: `ref-${refSeq++}`, name: "", source: "secret", resourceName: "", key: "" };
}

export interface EnvRefEditorProps {
  rows: EnvRefEdit[];
  secrets: Secret[];
  configMaps: ConfigMap[];
  onChange: (rows: EnvRefEdit[]) => void;
}

export function EnvRefEditor({ rows, secrets, configMaps, onChange }: EnvRefEditorProps) {
  function update(idx: number, patch: Partial<EnvRefEdit>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function resourcesFor(source: EnvRefEdit["source"]) {
    return source === "configMap" ? configMaps : secrets;
  }
  function keysFor(row: EnvRefEdit): string[] {
    const r = resourcesFor(row.source).find((x) => x.metadata.name === row.resourceName);
    return r?.data ? Object.keys(r.data).sort() : [];
  }

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background/40 p-2">
          <input
            value={row.name}
            placeholder="ENV_NAME"
            onChange={(e) => update(idx, { name: e.target.value })}
            className={`${inputClass} min-w-[120px] flex-1`}
            aria-label="env name"
          />
          <select
            value={row.source}
            onChange={(e) => update(idx, { source: e.target.value as EnvRefEdit["source"], resourceName: "", key: "" })}
            className={selectClass}
            aria-label="source"
          >
            <option value="secret">Secret</option>
            <option value="configMap">ConfigMap</option>
          </select>
          <select
            value={row.resourceName}
            onChange={(e) => update(idx, { resourceName: e.target.value, key: "" })}
            className={selectClass}
            aria-label="resource"
          >
            <option value="">— select —</option>
            {resourcesFor(row.source).map((r) => (
              <option key={r.metadata.name} value={r.metadata.name}>{r.metadata.name}</option>
            ))}
          </select>
          <select
            value={row.key}
            onChange={(e) => update(idx, { key: e.target.value })}
            className={selectClass}
            aria-label="key"
            disabled={!row.resourceName}
          >
            <option value="">— key —</option>
            {keysFor(row).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${row.name || "reference"}`}
            onClick={() => onChange(rows.filter((_, i) => i !== idx))}
          >
            <Minus className="size-4 text-destructive" aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, blankRef()])}>
        <Plus className="size-3.5" aria-hidden /> Add reference
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Wire live secrets/configmaps into `DeploymentEditor.tsx`.** Add imports near the top:

```tsx
import type { Secret, ConfigMap } from "@rigel/k8s";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { EnvRefEditor } from "./EnvRefEditor";
```

Inside the `DeploymentEditor` component, after the existing `useState` hooks, add the namespace + live-resource wiring:

```tsx
  const ns = target?.metadata.namespace ?? "default";
  const resources = useCluster((s) => s.resources);

  // While open, watch secrets + configmaps in the deployment's namespace so the
  // ref pickers list real resources. Unsubscribed on close.
  useEffect(() => {
    if (!open || !target) return;
    subscribe("secrets", ns);
    subscribe("configmaps", ns);
    return () => {
      unsubscribe("secrets", ns);
      unsubscribe("configmaps", ns);
    };
  }, [open, target, ns]);

  const secrets = (Object.values((resources["secrets"] ?? {}) as Record<string, Secret>))
    .filter((s) => (s.metadata.namespace ?? "default") === ns);
  const configMaps = (Object.values((resources["configmaps"] ?? {}) as Record<string, ConfigMap>))
    .filter((c) => (c.metadata.namespace ?? "default") === ns);
```

- [ ] **Step 3: Render `EnvRefEditor` under the plain env editor.** In the container's Environment block, insert the ref editor between the `KeyValueEditor` and the `c.otherRefKeys.length > 0` read-only block:

```tsx
                    <KeyValueEditor
                      rows={c.env}
                      onRowsChange={(rows: KVRow[]) => updateContainer(ci, { env: rows })}
                      keyPlaceholder="ENV_NAME"
                    />
                    <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From Secret / ConfigMap</div>
                    <EnvRefEditor
                      rows={c.envRefs}
                      secrets={secrets}
                      configMaps={configMaps}
                      onChange={(rows) => updateContainer(ci, { envRefs: rows })}
                    />
```

- [ ] **Step 4: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/EnvRefEditor.tsx apps/web/src/panels/deployments/DeploymentEditor.tsx
git commit -m "feat(deploy-editor): EnvRefEditor — add env vars from Secret/ConfigMap keys"
```

---

## Task 8: `ImagePullSecretsField` component + wire

**Files:**
- Create: `apps/web/src/panels/deployments/ImagePullSecretsField.tsx`
- Modify: `apps/web/src/panels/deployments/DeploymentEditor.tsx`

- [ ] **Step 1: Create `ImagePullSecretsField.tsx`** with this exact content:

```tsx
import { X } from "lucide-react";
import type { Secret } from "@rigel/k8s";

// ---------------------------------------------------------------------------
// ImagePullSecretsField — deployment-level picker for pod imagePullSecrets,
// used to pull images from private registries (e.g. GHCR). Lists namespace
// secrets of a docker-registry type as add options; selected names render as
// removable chips. Diffed by `diffDeployment` into a `setImagePullSecrets`
// merge patch (full desired list).
// ---------------------------------------------------------------------------

const REGISTRY_TYPES = new Set(["kubernetes.io/dockerconfigjson", "kubernetes.io/dockercfg"]);
const selectClass =
  "rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring";

export interface ImagePullSecretsFieldProps {
  value: string[];
  secrets: Secret[];
  onChange: (next: string[]) => void;
}

export function ImagePullSecretsField({ value, secrets, onChange }: ImagePullSecretsFieldProps) {
  const available = secrets.filter(
    (s) => REGISTRY_TYPES.has(s.type ?? "") && !value.includes(s.metadata.name),
  );

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Image pull secrets</div>
      <p className="text-[11px] text-muted-foreground">Authenticate to private registries (e.g. GHCR) when pulling images.</p>
      <div className="flex flex-wrap items-center gap-2">
        {value.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
        {value.map((n) => (
          <span key={n} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs font-mono">
            {n}
            <button
              type="button"
              aria-label={`Remove ${n}`}
              onClick={() => onChange(value.filter((x) => x !== n))}
              className="text-destructive hover:opacity-70"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <select
        value=""
        onChange={(e) => {
          const name = e.target.value;
          if (name && !value.includes(name)) onChange([...value, name]);
        }}
        className={selectClass}
        aria-label="Add image pull secret"
      >
        <option value="">+ Add registry secret…</option>
        {available.map((s) => (
          <option key={s.metadata.name} value={s.metadata.name}>{s.metadata.name}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `DeploymentEditor.tsx`.** Add the import:

```tsx
import { ImagePullSecretsField } from "./ImagePullSecretsField";
```

Render it as a deployment-level section, placed **after** the `model.containers.map(...)` block closes and before the closing `</div>` of the form container:

```tsx
              <ImagePullSecretsField
                value={model.imagePullSecrets}
                secrets={secrets}
                onChange={(next) => setModel({ ...model, imagePullSecrets: next })}
              />
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/deployments/ImagePullSecretsField.tsx apps/web/src/panels/deployments/DeploymentEditor.tsx
git commit -m "feat(deploy-editor): ImagePullSecretsField — attach registry secrets (GHCR)"
```

---

## Task 9: Convert editor Sheet → wide centered Dialog

**Files:**
- Modify: `apps/web/src/panels/deployments/DeploymentEditor.tsx`

- [ ] **Step 1: Swap the Sheet imports for Dialog.** Replace the `Sheet` import block:
```tsx
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
```
with:
```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
```

- [ ] **Step 2: Replace the Sheet markup with a wide Dialog.** Change the outer wrapper:
```tsx
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[92vh] overflow-auto">
          <SheetHeader>
            <SheetTitle>Edit {target?.metadata.name}</SheetTitle>
            <SheetDescription>
```
to:
```tsx
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Edit {target?.metadata.name}</DialogTitle>
            <DialogDescription>
```
And the matching closers — `</SheetHeader>`→`</DialogHeader>`, `<SheetFooter>`→`<DialogFooter>`, `</SheetFooter>`→`</DialogFooter>`, `</SheetContent>`→`</DialogContent>`, `</Sheet>`→`</Dialog>`.

- [ ] **Step 3: Verify typecheck + build (no lingering Sheet references)**

Run: `pnpm --filter web typecheck && pnpm --filter web build && ! grep -q "Sheet" apps/web/src/panels/deployments/DeploymentEditor.tsx && echo "no Sheet refs"`
Expected: PASS + `no Sheet refs`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/deployments/DeploymentEditor.tsx
git commit -m "feat(deploy-editor): present editor as a wide centered Dialog"
```

---

## Task 10: Full verification + Docker rebuild

**Files:** none (verification only)

- [ ] **Step 1: Run all web + server tests and typecheck**

Run:
```bash
pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter @rigel/server test
```
Expected: all PASS.

- [ ] **Step 2: Rebuild the running container** (the web app runs as a local Docker container; build/test alone won't update it):

Run: `docker compose up -d --build`
Expected: `rigel-web` rebuilt and running on :8787.

- [ ] **Step 3: Manual smoke (browser at http://localhost:8787)**
  - Open a Deployment's "Edit config…" → confirm it's a centered wide modal.
  - In Environment → "Add reference": pick Secret → a resource → a key; "Review changes" shows `kubectl patch … --type=strategic … secretKeyRef …`.
  - In "Image pull secrets": add a registry secret; "Review changes" shows `kubectl patch … --type=merge … imagePullSecrets …`.
  - Confirm + apply; verify the watch refreshes the panel.

- [ ] **Step 4: Update docs + tickets** (per the docs/tickets workflow): update the Rigel app's Outline doc (Deployment editor section: image-pull secrets + env-from-secret/configmap refs), and derive Plane tickets from the change.

---

## Self-review notes (addressed)

- **Spec coverage:** wide Dialog (Task 9), imagePullSecrets action+diff+UI (Tasks 2,5,8), env-ref action+diff+UI for both Secret & ConfigMap (Tasks 3,6,7), live namespace pickers (Task 7), typed `valueFrom` + `otherRefKeys` no-regression (Tasks 1,4), tests both sides (Tasks 2–6), Docker + docs (Task 10) — all covered.
- **Type consistency:** `EnvRefEdit` fields (`id,name,source,resourceName,key`) and the `envRefs` action shape (`name,source,resourceName,key`) are used identically across `deploymentDisplay.ts`, both `ActionBlock` interfaces, `EnvRefEditor.tsx`, and all tests. `otherRefKeys` replaces `refEnvKeys` everywhere (Task 4 Step 4 migrates the editor; Task 4 Step 1 migrates the test).
- **Breaking-change ordering:** Task 4 changes the model AND fixes the only consumer (`DeploymentEditor.tsx` read-only block) in the same task, so typecheck stays green between commits.
