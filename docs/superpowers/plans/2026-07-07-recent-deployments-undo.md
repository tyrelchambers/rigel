# Recent deployments / Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a one-click "undo" for anything they applied through Rigel (Compose migration, catalog manifest install, Apply YAML), surfaced as a "Recent" card on Overview.

**Architecture:** At apply time the server annotates only the resources a `kubectl apply` newly *created* with `rigel.dev/apply-batch` + `applied-at` + `apply-source` (parsing apply stdout for `created` lines, resolving each namespace from the applied YAML). "Recent deployments" queries the cluster for those annotations (purge-style discovery) within a 14-day window, grouped by batch. Undo deletes every resource carrying a batch id, through the existing red destructive confirm. This is structurally "Purge, but discovered by an apply-batch annotation instead of an instance label," so it reuses purge's discovery/delete machinery.

**Tech Stack:** TypeScript monorepo. Pure logic + constants in `packages/k8s`; server routes in `apps/server`; React 19 + TanStack Query + Zustand in `apps/web`. Tests: vitest. YAML parsing via the `yaml` package.

**Spec deviation note:** The spec placed the annotation constants in `packages/catalog/src/types.ts`. This plan places them in `packages/k8s` instead: the apply-batch annotations are not catalog-specific, both consumers (server stamping, k8s discovery) live at or below the k8s layer, and neither `packages/k8s` nor `apps/server` currently depends on `@rigel/catalog`. The one-constant-plus-single-reader *convention* from `CATALOG_APP_ANNOTATION`/`boundAppID` is preserved.

**Field-name note:** `ActionBlock.source` already exists (it's `proposeRepoFix`'s git source). The apply-source is threaded on a new distinct field `applySource`.

---

## File Structure

**Created:**
- `packages/k8s/src/applyBatch.ts` — the 3 annotation constants, `ApplySource` type, single reader `applyBatchOf`.
- `packages/k8s/src/applyStamp.ts` — pure helpers: parse applied YAML → resources, parse apply stdout → created, build `kubectl annotate` argv (grouped by namespace).
- `packages/k8s/src/applyStamp.test.ts`, `packages/k8s/src/applyBatch.test.ts`
- `packages/k8s/src/recentDeploys.ts` — pure discovery: query argv, group items into batches within the window.
- `packages/k8s/src/recentDeploys.test.ts`
- `apps/server/src/recentDeploys.ts` — `discoverRecent` + `undoBatch` (injectable runners).
- `apps/server/src/recentDeploys.test.ts`
- `apps/web/src/panels/overview/RecentDeploysCard.tsx` — the Overview card + Undo confirm.
- `apps/web/src/panels/overview/RecentDeploysCard.test.tsx`

**Modified:**
- `packages/k8s/src/index.ts` — re-export the new modules.
- `packages/k8s/package.json` — add `yaml` dep.
- `apps/server/src/install.ts` — thread `source` into `applyManifest`, stamp after a successful apply.
- `apps/server/src/install.test.ts` — stamping tests.
- `apps/server/src/index.ts` — pass `body.source` to `applyManifest`; add `GET /api/deployments/recent` + `POST /api/deployments/undo`.
- `apps/web/src/lib/api.ts` — `applyManifestYaml(yaml, dryRun, source?)`; `applySource` on `ActionBlock`; `fetchRecentDeploys`/`undoDeploy` + hooks.
- `apps/web/src/components/ConfirmSheet.tsx` — pass `act.applySource` to `applyManifestYaml`.
- `apps/web/src/panels/compose/ComposeMigratePanel.tsx` — set `applySource: "compose-migration"`.
- `apps/web/src/panels/apply/ApplyYamlPanel.tsx` — set `applySource: "apply-yaml"`.
- `apps/web/src/panels/catalog/installApi.ts` + `CatalogInstallWizard.tsx` — pass `"catalog-install"`.
- `apps/web/src/panels/overview/OverviewPanel.tsx` — mount `RecentDeploysCard`.

---

## Task 1: Apply-batch annotation constants + reader

**Files:**
- Create: `packages/k8s/src/applyBatch.ts`
- Test: `packages/k8s/src/applyBatch.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/applyBatch.test.ts
import { describe, expect, test } from "vitest";
import {
  APPLY_BATCH_ANNOTATION,
  APPLIED_AT_ANNOTATION,
  APPLY_SOURCE_ANNOTATION,
  applyBatchOf,
} from "./applyBatch";

describe("applyBatch constants", () => {
  test("keys are the frozen rigel.dev contract strings", () => {
    expect(APPLY_BATCH_ANNOTATION).toBe("rigel.dev/apply-batch");
    expect(APPLIED_AT_ANNOTATION).toBe("rigel.dev/applied-at");
    expect(APPLY_SOURCE_ANNOTATION).toBe("rigel.dev/apply-source");
  });

  test("applyBatchOf reads the batch id or returns null", () => {
    expect(applyBatchOf({ annotations: { "rigel.dev/apply-batch": "b1" } })).toBe("b1");
    expect(applyBatchOf({ annotations: {} })).toBeNull();
    expect(applyBatchOf({})).toBeNull();
    expect(applyBatchOf(undefined)).toBeNull();
    expect(applyBatchOf({ annotations: { "rigel.dev/apply-batch": "" } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- applyBatch`
Expected: FAIL — `Cannot find module './applyBatch'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/applyBatch.ts
// Annotations Rigel stamps on resources it CREATES via an apply, so "Recent
// deployments" can find them and Undo can delete exactly what a batch created.
// One constant per key + one reader, mirroring catalog's CATALOG_APP_ANNOTATION
// / boundAppID convention. Neither the app nor any tooling may re-derive these.

/** The apply batch a resource was created by (crypto.randomUUID). */
export const APPLY_BATCH_ANNOTATION = "rigel.dev/apply-batch";
/** ISO 8601 timestamp of the apply that created the resource. */
export const APPLIED_AT_ANNOTATION = "rigel.dev/applied-at";
/** Which Rigel surface performed the apply. */
export const APPLY_SOURCE_ANNOTATION = "rigel.dev/apply-source";

/** The Rigel apply surfaces that stamp a batch. */
export type ApplySource = "compose-migration" | "catalog-install" | "apply-yaml";

const APPLY_SOURCES: readonly ApplySource[] = [
  "compose-migration",
  "catalog-install",
  "apply-yaml",
];

/** Narrow an arbitrary string to a valid ApplySource, or null. */
export function asApplySource(v: string | undefined | null): ApplySource | null {
  return v != null && (APPLY_SOURCES as readonly string[]).includes(v) ? (v as ApplySource) : null;
}

/**
 * The apply batch id a resource carries, or null. The ONLY reader of
 * APPLY_BATCH_ANNOTATION.
 */
export function applyBatchOf(meta?: { annotations?: Record<string, string> }): string | null {
  const v = meta?.annotations?.[APPLY_BATCH_ANNOTATION];
  return v && v.length > 0 ? v : null;
}
```

- [ ] **Step 4: Add the re-export to the package index**

In `packages/k8s/src/index.ts`, add near the other `export {` groups:

```ts
export {
  APPLY_BATCH_ANNOTATION,
  APPLIED_AT_ANNOTATION,
  APPLY_SOURCE_ANNOTATION,
  asApplySource,
  applyBatchOf,
  type ApplySource,
} from "./applyBatch";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- applyBatch`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/applyBatch.ts packages/k8s/src/applyBatch.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): apply-batch annotation constants + reader (HELM-60)"
```

---

## Task 2: Stamp-command builder (parse applied YAML + apply stdout)

**Files:**
- Create: `packages/k8s/src/applyStamp.ts`
- Test: `packages/k8s/src/applyStamp.test.ts`
- Modify: `packages/k8s/package.json` (add `yaml`), `packages/k8s/src/index.ts`

- [ ] **Step 1: Add the `yaml` dependency**

In `packages/k8s/package.json`, add to `dependencies` (match the version string used in `packages/compose/package.json`):

```json
"yaml": "latest"
```

Then install: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// packages/k8s/src/applyStamp.test.ts
import { describe, expect, test } from "vitest";
import {
  parseAppliedResources,
  parseCreatedResources,
  buildStampCommands,
} from "./applyStamp";

const YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: web-data
`;

const STDOUT = [
  "deployment.apps/web created",
  "service/web created",
  "persistentvolumeclaim/web-data created",
  "configmap/leftover configured",
  "Warning: some deprecation",
].join("\n");

describe("parseAppliedResources", () => {
  test("extracts kind/name/namespace from every doc", () => {
    expect(parseAppliedResources(YAML)).toEqual([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
      { kind: "PersistentVolumeClaim", name: "web-data", namespace: undefined },
    ]);
  });

  test("ignores empty / null docs and docs without kind or name", () => {
    expect(parseAppliedResources("---\n---\nfoo: bar\n")).toEqual([]);
  });
});

describe("parseCreatedResources", () => {
  test("keeps only 'created' lines, splitting the type token to a kind", () => {
    expect(parseCreatedResources(STDOUT)).toEqual([
      { kind: "deployment", name: "web" },
      { kind: "service", name: "web" },
      { kind: "persistentvolumeclaim", name: "web-data" },
    ]);
  });
});

describe("buildStampCommands", () => {
  const meta = { batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "compose-migration" as const };

  test("annotates only created resources, grouped by namespace", () => {
    const created = parseCreatedResources(STDOUT);
    const parsed = parseAppliedResources(YAML);
    const cmds = buildStampCommands(created, parsed, meta);
    expect(cmds).toEqual([
      [
        "annotate",
        "deployment/web",
        "service/web",
        "rigel.dev/apply-batch=b1",
        "rigel.dev/applied-at=2026-07-07T10:00:00.000Z",
        "rigel.dev/apply-source=compose-migration",
        "--overwrite",
        "-n",
        "shop",
      ],
      [
        "annotate",
        "persistentvolumeclaim/web-data",
        "rigel.dev/apply-batch=b1",
        "rigel.dev/applied-at=2026-07-07T10:00:00.000Z",
        "rigel.dev/apply-source=compose-migration",
        "--overwrite",
      ],
    ]);
  });

  test("returns [] when nothing was created", () => {
    expect(buildStampCommands([], parseAppliedResources(YAML), meta)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- applyStamp`
Expected: FAIL — `Cannot find module './applyStamp'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/k8s/src/applyStamp.ts
// Pure helpers for stamping apply-batch annotations onto the resources a
// `kubectl apply` newly CREATED. Kept pure (no process spawning) so the argv is
// fully unit-testable; the server side (install.ts) runs the returned commands.

import { parseAllDocuments } from "yaml";
import {
  APPLY_BATCH_ANNOTATION,
  APPLIED_AT_ANNOTATION,
  APPLY_SOURCE_ANNOTATION,
  type ApplySource,
} from "./applyBatch";

export interface AppliedResource {
  kind: string; // as written in the manifest, e.g. "Deployment"
  name: string;
  namespace: string | undefined;
}

export interface CreatedResource {
  kind: string; // singular lowercase, e.g. "deployment"
  name: string;
}

export interface StampMeta {
  batchId: string;
  appliedAt: string;
  source: ApplySource;
}

/** Parse a multi-doc manifest string into {kind,name,namespace} descriptors. */
export function parseAppliedResources(yaml: string): AppliedResource[] {
  const out: AppliedResource[] = [];
  for (const doc of parseAllDocuments(yaml)) {
    const obj = doc.toJSON() as
      | { kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } }
      | null;
    if (!obj || typeof obj.kind !== "string") continue;
    const name = obj.metadata?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const ns = obj.metadata?.namespace;
    out.push({ kind: obj.kind, name, namespace: typeof ns === "string" ? ns : undefined });
  }
  return out;
}

/**
 * Parse `kubectl apply` stdout, keeping only the resources it reported as
 * `created`. Lines look like `deployment.apps/web created` or `service/web
 * created`; the kind is the token before the first `.` or `/`.
 */
export function parseCreatedResources(stdout: string): CreatedResource[] {
  const out: CreatedResource[] = [];
  for (const raw of stdout.split("\n")) {
    const m = /^(\S+?)\/(\S+)\s+created$/.exec(raw.trim());
    if (!m) continue;
    const kind = m[1]!.split(".")[0]!.toLowerCase();
    out.push({ kind, name: m[2]! });
  }
  return out;
}

/**
 * Build `kubectl annotate` argv (verb onward) for exactly the created
 * resources, grouped by namespace. Namespace comes from the applied manifest;
 * resources whose manifest omitted a namespace are annotated without `-n` (so
 * kubectl uses the same default the apply used). Returns [] if nothing created.
 */
export function buildStampCommands(
  created: CreatedResource[],
  applied: AppliedResource[],
  meta: StampMeta,
): string[][] {
  if (created.length === 0) return [];

  const nsByKey = new Map<string, string | undefined>();
  for (const r of applied) nsByKey.set(`${r.kind.toLowerCase()}/${r.name}`, r.namespace);

  // Group the created resources' `kind/name` tokens by resolved namespace.
  // Map key "" == cluster-default (no -n); preserves first-seen order.
  const groups = new Map<string, string[]>();
  for (const c of created) {
    const token = `${c.kind}/${c.name}`;
    const ns = nsByKey.get(token) ?? "";
    const bucket = groups.get(ns);
    if (bucket) bucket.push(token);
    else groups.set(ns, [token]);
  }

  const annotations = [
    `${APPLY_BATCH_ANNOTATION}=${meta.batchId}`,
    `${APPLIED_AT_ANNOTATION}=${meta.appliedAt}`,
    `${APPLY_SOURCE_ANNOTATION}=${meta.source}`,
  ];

  const cmds: string[][] = [];
  for (const [ns, tokens] of groups) {
    cmds.push(["annotate", ...tokens, ...annotations, "--overwrite", ...(ns ? ["-n", ns] : [])]);
  }
  return cmds;
}
```

- [ ] **Step 5: Add re-exports**

In `packages/k8s/src/index.ts`:

```ts
export {
  parseAppliedResources,
  parseCreatedResources,
  buildStampCommands,
  type AppliedResource,
  type CreatedResource,
  type StampMeta,
} from "./applyStamp";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- applyStamp`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add packages/k8s/src/applyStamp.ts packages/k8s/src/applyStamp.test.ts packages/k8s/src/index.ts packages/k8s/package.json
git commit -m "feat(k8s): stamp-command builder for created resources (HELM-60)"
```

---

## Task 3: Wire stamping into `applyManifest`

**Files:**
- Modify: `apps/server/src/install.ts`
- Test: `apps/server/src/install.test.ts`
- Modify: `apps/server/src/index.ts` (pass `body.source`)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/install.test.ts` (import additions at top: `import { applyManifest } from "./install";`):

```ts
import { describe, expect, test, vi } from "vitest";

describe("applyManifest stamping", () => {
  const yaml = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "  namespace: shop",
  ].join("\n");

  test("annotates created resources with a batch when source is given", async () => {
    const applyRun = vi.fn().mockResolvedValue({ code: 0, stdout: "deployment.apps/web created", stderr: "" });
    const annotateRun = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const res = await applyManifest(null, yaml, false, "compose-migration", {
      applyRun,
      annotateRun,
      idGen: () => "batch-1",
      clock: () => new Date("2026-07-07T10:00:00.000Z"),
    });

    expect(res.code).toBe(0);
    expect(res.batchId).toBe("batch-1");
    expect(annotateRun).toHaveBeenCalledTimes(1);
    expect(annotateRun).toHaveBeenCalledWith(null, [
      "annotate",
      "deployment/web",
      "rigel.dev/apply-batch=batch-1",
      "rigel.dev/applied-at=2026-07-07T10:00:00.000Z",
      "rigel.dev/apply-source=compose-migration",
      "--overwrite",
      "-n",
      "shop",
    ]);
  });

  test("does not annotate on dryRun, missing source, invalid source, or apply failure", async () => {
    const annotateRun = vi.fn();
    const ok = { code: 0, stdout: "deployment.apps/web created", stderr: "" };
    const base = { annotateRun, idGen: () => "b", clock: () => new Date(0) };

    await applyManifest(null, yaml, true, "compose-migration", { applyRun: vi.fn().mockResolvedValue(ok), ...base });
    await applyManifest(null, yaml, false, undefined, { applyRun: vi.fn().mockResolvedValue(ok), ...base });
    await applyManifest(null, yaml, false, "bogus", { applyRun: vi.fn().mockResolvedValue(ok), ...base });
    await applyManifest(null, yaml, false, "compose-migration", {
      applyRun: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" }),
      ...base,
    });

    expect(annotateRun).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test -- install`
Expected: FAIL — `applyManifest` does not accept a source/deps arg; `res.batchId` undefined; annotate never called.

- [ ] **Step 3: Rewrite `applyManifest` in `apps/server/src/install.ts`**

Replace the existing `applyManifest` function (lines 31-38) and add imports. At the top of the file, extend the `@rigel/k8s/src/run` import and add:

```ts
import { buildKubectlArgs, kubectl, runProcess, runProcessWithStdin, type RunResult } from "@rigel/k8s/src/run";
import {
  asApplySource,
  buildStampCommands,
  parseAppliedResources,
  parseCreatedResources,
  type ApplySource,
} from "@rigel/k8s";
import { randomUUID } from "node:crypto";
```

Then:

```ts
export interface ApplyResult extends RunResult {
  /** Set when this apply created resources and stamped a batch. */
  batchId?: string;
}

/** Injectable runners/clock so stamping is testable without spawning kubectl. */
export interface ApplyDeps {
  applyRun: (context: string | null, argv: string[], stdin: string) => Promise<RunResult>;
  annotateRun: (context: string | null, argv: string[]) => Promise<RunResult>;
  idGen: () => string;
  clock: () => Date;
}

const defaultApplyDeps: ApplyDeps = {
  applyRun: (context, argv, stdin) => runProcessWithStdin("kubectl", buildKubectlArgs(context, argv), stdin),
  annotateRun: (context, argv) => kubectl(context, argv),
  idGen: () => randomUUID(),
  clock: () => new Date(),
};

/**
 * Run `kubectl apply -f -` feeding `yaml` on STDIN. When `source` is a valid
 * ApplySource and this is not a dryRun, the resources the apply reported as
 * `created` are annotated with a fresh apply-batch (best-effort: annotate
 * failures do not fail the apply). Returns the apply result plus `batchId`.
 */
export async function applyManifest(
  context: string | null,
  yaml: string,
  dryRun = false,
  source?: string,
  deps: ApplyDeps = defaultApplyDeps,
): Promise<ApplyResult> {
  const applyArgv = ["apply", "-f", "-", ...(dryRun ? ["--dry-run=server"] : [])];
  const result = await deps.applyRun(context, applyArgv, yaml);
  if (result.code !== 0 || dryRun) return result;

  const applySource = asApplySource(source);
  if (!applySource) return result;

  const created = parseCreatedResources(result.stdout);
  const applied = parseAppliedResources(yaml);
  const batchId = deps.idGen();
  const cmds = buildStampCommands(created, applied, {
    batchId,
    appliedAt: deps.clock().toISOString(),
    source: applySource,
  });
  if (cmds.length === 0) return result;

  for (const cmd of cmds) await deps.annotateRun(context, cmd); // best-effort
  return { ...result, batchId };
}
```

Note: `buildApplyArgs` (lines 21-23) is now unused by `applyManifest` but is still exported and used by tests — leave it in place.

- [ ] **Step 4: Pass `source` through the `/api/apply` route**

In `apps/server/src/index.ts`, update the `/api/apply` handler body type and call (around line 448-457):

```ts
let body: { yaml?: string; dryRun?: boolean; source?: string };
try {
  body = (await req.json()) as { yaml?: string; dryRun?: boolean; source?: string };
} catch {
  return Response.json({ error: "invalid JSON body" }, { status: 400 });
}
if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
  return Response.json({ error: "missing yaml" }, { status: 422 });
}
const result = await applyManifest(context, body.yaml, body.dryRun === true, body.source);
return Response.json(result);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rigel/server test -- install`
Expected: PASS. Then `pnpm --filter @rigel/server typecheck` — expected: clean (pre-existing assistant.ts webhook errors, if any, are unrelated — confirm no NEW errors in install.ts/index.ts).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/install.ts apps/server/src/install.test.ts apps/server/src/index.ts
git commit -m "feat(server): stamp apply-batch annotations on created resources (HELM-60)"
```

---

## Task 4: Thread `applySource` through the web apply callers

**Files:**
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/components/ConfirmSheet.tsx`, `apps/web/src/panels/compose/ComposeMigratePanel.tsx`, `apps/web/src/panels/apply/ApplyYamlPanel.tsx`, `apps/web/src/panels/catalog/installApi.ts`, `apps/web/src/panels/catalog/CatalogInstallWizard.tsx`
- Test: `apps/web/src/lib/api.test.ts` (create if absent, else append)

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/api.test.ts  (append or create)
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyManifestYaml } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("applyManifestYaml", () => {
  test("includes source in the POST body when provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));

    await applyManifestYaml("kind: X", false, "compose-migration");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      yaml: "kind: X",
      dryRun: false,
      source: "compose-migration",
    });
  });

  test("omits source when not provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));

    await applyManifestYaml("kind: X", true);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- api`
Expected: FAIL — `applyManifestYaml` ignores the third arg / body has no `source`.

- [ ] **Step 3: Update `applyManifestYaml` + `ActionBlock` + `ActionResult` in `apps/web/src/lib/api.ts`**

Replace `applyManifestYaml` (lines 93-104):

```ts
import type { ApplySource } from "@rigel/k8s";

export async function applyManifestYaml(
  yaml: string,
  dryRun = false,
  source?: ApplySource,
): Promise<ActionResult> {
  const res = await fetch("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml, dryRun, ...(source ? { source } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResult>;
}
```

Add `applySource` to the `ActionBlock` interface (after the `manifest?` field, line 32):

```ts
  /** applyManifest only — which Rigel surface triggered the apply (batch stamping). */
  applySource?: ApplySource;
```

Add optional `batchId` to `ActionResult` (after line 48):

```ts
  /** applyManifest only — set when the apply created resources and stamped a batch. */
  batchId?: string;
```

- [ ] **Step 4: Pass `applySource` from `ConfirmSheet.handleApply`**

In `apps/web/src/components/ConfirmSheet.tsx`, in `handleApply()` (line ~142), change:

```ts
      const result = await applyManifestYaml(act.manifest);
```
to:
```ts
      const result = await applyManifestYaml(act.manifest, false, act.applySource);
```

- [ ] **Step 5: Set `applySource` on the compose + apply-yaml action blocks**

`apps/web/src/panels/compose/ComposeMigratePanel.tsx`, in `handleApply()`:
```ts
    setPendingAction({
      kind: "applyManifest",
      label: "Apply migrated manifests",
      manifest: manifestYaml,
      applySource: "compose-migration",
    });
```

`apps/web/src/panels/apply/ApplyYamlPanel.tsx`, where it builds the `applyManifest` action block (around line 55), add `applySource: "apply-yaml"` to that object.

- [ ] **Step 6: Pass source through the catalog manifest install**

`apps/web/src/panels/catalog/installApi.ts`, replace `applyManifest`:
```ts
import type { ApplySource } from "@rigel/k8s";

export function applyManifest(yaml: string, source?: ApplySource): Promise<InstallResult> {
  return postJSON<InstallResult>("/api/apply", { yaml, ...(source ? { source } : {}) });
}
```
Update `useApplyManifest` to forward the source (change the mutation variable to an object):
```ts
export function useApplyManifest() {
  return useMutation<InstallResult, Error, { yaml: string; source?: ApplySource }>({
    mutationFn: ({ yaml, source }) => applyManifest(yaml, source),
  });
}
```
In `apps/web/src/panels/catalog/CatalogInstallWizard.tsx` (line ~199) change `await applyManifest(artifact)` to `await applyManifest(artifact, "catalog-install")`. If it uses the `useApplyManifest` mutation instead, call `.mutateAsync({ yaml: artifact, source: "catalog-install" })`. Match whichever the wizard actually uses.

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter web test -- api` — Expected: PASS.
Run: `pnpm --filter web typecheck` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/components/ConfirmSheet.tsx apps/web/src/panels/compose/ComposeMigratePanel.tsx apps/web/src/panels/apply/ApplyYamlPanel.tsx apps/web/src/panels/catalog/installApi.ts apps/web/src/panels/catalog/CatalogInstallWizard.tsx
git commit -m "feat(web): tag Rigel applies with their source for batch stamping (HELM-60)"
```

---

## Task 5: Recent-deploys discovery (pure logic)

**Files:**
- Create: `packages/k8s/src/recentDeploys.ts`
- Test: `packages/k8s/src/recentDeploys.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/recentDeploys.test.ts
import { describe, expect, test } from "vitest";
import { RECENT_WINDOW_MS, recentDiscoveryArgs, groupRecentBatches } from "./recentDeploys";

const now = Date.parse("2026-07-07T12:00:00.000Z");

function item(kind: string, name: string, ns: string, ann: Record<string, string>) {
  return { kind, metadata: { name, namespace: ns, annotations: ann } };
}

const recent = "2026-07-07T10:00:00.000Z";
const old = "2026-06-01T10:00:00.000Z"; // > 14 days ago

describe("recentDiscoveryArgs", () => {
  test("queries all discovery kinds across all namespaces as json", () => {
    const args = recentDiscoveryArgs();
    expect(args[0]).toBe("get");
    expect(args).toContain("--all-namespaces");
    expect(args).toEqual(["get", args[1], "--all-namespaces", "-o", "json"]);
  });
});

describe("groupRecentBatches", () => {
  test("groups in-window items by batch id, newest batch first", () => {
    const items = [
      item("Deployment", "web", "shop", { "rigel.dev/apply-batch": "b1", "rigel.dev/applied-at": recent, "rigel.dev/apply-source": "compose-migration" }),
      item("Service", "web", "shop", { "rigel.dev/apply-batch": "b1", "rigel.dev/applied-at": recent, "rigel.dev/apply-source": "compose-migration" }),
      item("Deployment", "api", "shop", { "rigel.dev/apply-batch": "b2", "rigel.dev/applied-at": "2026-07-07T11:00:00.000Z", "rigel.dev/apply-source": "apply-yaml" }),
    ];
    const batches = groupRecentBatches(items, now, RECENT_WINDOW_MS);
    expect(batches).toEqual([
      { batchId: "b2", source: "apply-yaml", appliedAt: "2026-07-07T11:00:00.000Z", resources: [{ kind: "Deployment", name: "api", namespace: "shop" }] },
      { batchId: "b1", source: "compose-migration", appliedAt: recent, resources: [
        { kind: "Deployment", name: "web", namespace: "shop" },
        { kind: "Service", name: "web", namespace: "shop" },
      ] },
    ]);
  });

  test("drops items outside the window and items without a batch annotation", () => {
    const items = [
      item("Deployment", "old", "shop", { "rigel.dev/apply-batch": "b0", "rigel.dev/applied-at": old, "rigel.dev/apply-source": "apply-yaml" }),
      item("Deployment", "plain", "shop", {}),
    ];
    expect(groupRecentBatches(items, now, RECENT_WINDOW_MS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- recentDeploys`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/recentDeploys.ts
// Pure discovery for "Recent deployments": query the cluster for resources
// carrying an apply-batch annotation and group them into batches within a
// recent window. No process spawning — the server (recentDeploys.ts) runs the
// query and calls groupRecentBatches on the parsed items.

import { DISCOVERY_KINDS } from "./purge";
import { APPLY_BATCH_ANNOTATION, APPLIED_AT_ANNOTATION, APPLY_SOURCE_ANNOTATION } from "./applyBatch";

/** Recent window: 14 days (spec §Recent deployments query). */
export const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface RecentResource {
  kind: string;
  name: string;
  namespace: string;
}

export interface RecentBatch {
  batchId: string;
  source: string;
  appliedAt: string;
  resources: RecentResource[];
}

/** A raw item from `kubectl get … -o json` `.items`. */
export interface RawRecentItem {
  kind?: string;
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
}

/** Build the kubectl argv (verb onward) for the recent-deploys query. */
export function recentDiscoveryArgs(): string[] {
  return ["get", DISCOVERY_KINDS.join(","), "--all-namespaces", "-o", "json"];
}

/**
 * Group in-window, batch-annotated items into batches, newest batch first.
 * `nowMs` is injected for testability; `windowMs` defaults to RECENT_WINDOW_MS.
 */
export function groupRecentBatches(
  items: RawRecentItem[],
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): RecentBatch[] {
  const byBatch = new Map<string, RecentBatch>();
  for (const it of items) {
    const ann = it.metadata?.annotations ?? {};
    const batchId = ann[APPLY_BATCH_ANNOTATION];
    const appliedAt = ann[APPLIED_AT_ANNOTATION];
    const kind = it.kind;
    const name = it.metadata?.name;
    if (!batchId || !appliedAt || !kind || !name) continue;
    const ts = Date.parse(appliedAt);
    if (Number.isNaN(ts) || nowMs - ts > windowMs) continue;

    let batch = byBatch.get(batchId);
    if (!batch) {
      batch = { batchId, source: ann[APPLY_SOURCE_ANNOTATION] ?? "", appliedAt, resources: [] };
      byBatch.set(batchId, batch);
    }
    batch.resources.push({ kind, name, namespace: it.metadata?.namespace ?? "" });
  }
  return [...byBatch.values()].sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
}
```

- [ ] **Step 4: Add re-exports**

In `packages/k8s/src/index.ts`:

```ts
export {
  RECENT_WINDOW_MS,
  recentDiscoveryArgs,
  groupRecentBatches,
  type RecentBatch,
  type RecentResource,
  type RawRecentItem,
} from "./recentDeploys";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- recentDeploys`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/recentDeploys.ts packages/k8s/src/recentDeploys.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): recent-deploys discovery + batch grouping (HELM-60)"
```

---

## Task 6: Recent-deploys server module + routes (discover + undo)

**Files:**
- Create: `apps/server/src/recentDeploys.ts`
- Test: `apps/server/src/recentDeploys.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/recentDeploys.test.ts
import { describe, expect, test, vi } from "vitest";
import { discoverRecent, undoBatch } from "./recentDeploys";

describe("discoverRecent", () => {
  test("runs the query and returns grouped batches", async () => {
    const items = {
      items: [
        { kind: "Deployment", metadata: { name: "web", namespace: "shop", annotations: { "rigel.dev/apply-batch": "b1", "rigel.dev/applied-at": "2026-07-07T10:00:00.000Z", "rigel.dev/apply-source": "compose-migration" } } },
      ],
    };
    const kubectlRun = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(items), stderr: "" });
    const now = Date.parse("2026-07-07T12:00:00.000Z");

    const res = await discoverRecent(null, now, { kubectlRun });
    expect(kubectlRun.mock.calls[0]![1]).toEqual(["get", expect.any(String), "--all-namespaces", "-o", "json"]);
    expect(res.batches).toHaveLength(1);
    expect(res.batches[0]!.batchId).toBe("b1");
  });

  test("returns empty on query failure", async () => {
    const kubectlRun = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    const res = await discoverRecent(null, Date.now(), { kubectlRun });
    expect(res.batches).toEqual([]);
  });
});

describe("undoBatch", () => {
  test("deletes each resource and reports per-resource results", async () => {
    const kubectlRun = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found" });

    const res = await undoBatch(
      null,
      [
        { kind: "Deployment", name: "web", namespace: "shop" },
        { kind: "Service", name: "web", namespace: "shop" },
      ],
      { kubectlRun },
    );

    expect(kubectlRun.mock.calls[0]![1]).toEqual(["delete", "deployment", "web", "-n", "shop"]);
    expect(res.results).toEqual([
      { resource: "Deployment/web", ok: true, detail: "deleted" },
      { resource: "Service/web", ok: false, detail: "not found" },
    ]);
    expect(res.ok).toBe(false);
  });

  test("skips resources with an unknown kind", async () => {
    const kubectlRun = vi.fn();
    const res = await undoBatch(null, [{ kind: "CustomThing", name: "x", namespace: "shop" }], { kubectlRun });
    expect(kubectlRun).not.toHaveBeenCalled();
    expect(res.results).toEqual([{ resource: "CustomThing/x", ok: false, detail: "skipped — unsupported kind" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test -- recentDeploys`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/recentDeploys.ts
// Recent deployments / Undo — server route logic.
//   GET  /api/deployments/recent → discover: query batch-annotated resources,
//        group into batches within the recent window.
//   POST /api/deployments/undo   → delete every resource in a batch (kubectl
//        delete per resource), routed through the client's red confirm.
//
// Pure discovery/grouping + delete-argv building live in @rigel/k8s. All
// binaries spawn via argv arrays (no shell); --context is prepended by kubectl.

import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  canonicalKind,
  deleteArgs,
  groupRecentBatches,
  recentDiscoveryArgs,
  type RawRecentItem,
  type RecentBatch,
  type RecentResource,
} from "@rigel/k8s";

export interface RecentRunners {
  kubectlRun: (context: string | null, args: string[]) => Promise<RunResult>;
}

const defaultRunners: RecentRunners = { kubectlRun: kubectl };

export interface DiscoverRecentResponse {
  batches: RecentBatch[];
}

export interface UndoResultEntry {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface UndoResponse {
  ok: boolean;
  results: UndoResultEntry[];
}

/** Query the cluster and group recent batch-annotated resources. */
export async function discoverRecent(
  context: string | null,
  nowMs: number,
  runners: RecentRunners = defaultRunners,
): Promise<DiscoverRecentResponse> {
  const res = await runners.kubectlRun(context, recentDiscoveryArgs());
  if (res.code !== 0) return { batches: [] };
  let items: RawRecentItem[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as { items?: RawRecentItem[] };
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return { batches: [] };
  }
  return { batches: groupRecentBatches(items, nowMs) };
}

/** Delete each resource in a batch; report per-resource outcomes. */
export async function undoBatch(
  context: string | null,
  resources: RecentResource[],
  runners: RecentRunners = defaultRunners,
): Promise<UndoResponse> {
  const results: UndoResultEntry[] = [];
  for (const r of resources) {
    const resource = `${r.kind}/${r.name}`;
    const kind = canonicalKind(r.kind);
    if (!kind) {
      results.push({ resource, ok: false, detail: "skipped — unsupported kind" });
      continue;
    }
    const del = await runners.kubectlRun(context, deleteArgs(kind, r.name, r.namespace));
    const ok = del.code === 0;
    results.push({ resource, ok, detail: ok ? "deleted" : (del.stderr.trim() || `exit ${del.code}`) });
  }
  return { ok: results.every((r) => r.ok), results };
}
```

- [ ] **Step 4: Register the routes in `apps/server/src/index.ts`**

Add imports near the `handlePurge` import:
```ts
import { discoverRecent, undoBatch, type RecentRunners } from "./recentDeploys";
import type { RecentResource } from "@rigel/k8s";
```

Add the two handlers (place them alongside the other `/api/*` routes, e.g. after the `/api/purge` block):
```ts
    // GET /api/deployments/recent — batches Rigel applied within the 14-day
    // window (resources carrying rigel.dev/apply-batch), newest first.
    if (url.pathname === "/api/deployments/recent" && req.method === "GET") {
      const result = await discoverRecent(context, Date.now());
      return Response.json(result);
    }

    // POST /api/deployments/undo — delete every resource in a batch. Body:
    // { resources: [{ kind, name, namespace }] }. kubectl delete per resource.
    if (url.pathname === "/api/deployments/undo" && req.method === "POST") {
      let body: { resources?: RecentResource[] };
      try {
        body = (await req.json()) as { resources?: RecentResource[] };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!Array.isArray(body.resources) || body.resources.length === 0) {
        return Response.json({ error: "missing resources" }, { status: 422 });
      }
      const result = await undoBatch(context, body.resources);
      return Response.json(result);
    }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @rigel/server test -- recentDeploys` — Expected: PASS.
Run: `pnpm --filter @rigel/server typecheck` — Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/recentDeploys.ts apps/server/src/recentDeploys.test.ts apps/server/src/index.ts
git commit -m "feat(server): recent-deploys discover + undo routes (HELM-60)"
```

---

## Task 7: Client API helpers + hooks (recent + undo)

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/api.test.ts`:

```ts
import { fetchRecentDeploys, undoDeploy } from "./api";

describe("recent deploys api", () => {
  test("fetchRecentDeploys GETs the recent endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ batches: [] }), { status: 200 }));
    const res = await fetchRecentDeploys();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/deployments/recent");
    expect(res).toEqual({ batches: [] });
  });

  test("undoDeploy POSTs the resource list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }));
    const resources = [{ kind: "Deployment", name: "web", namespace: "shop" }];
    await undoDeploy(resources);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/deployments/undo");
    expect(JSON.parse(init!.body as string)).toEqual({ resources });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- api`
Expected: FAIL — `fetchRecentDeploys`/`undoDeploy` not exported.

- [ ] **Step 3: Add helpers + hooks to `apps/web/src/lib/api.ts`**

```ts
import type { RecentBatch, RecentResource } from "@rigel/k8s";

export interface RecentDeploysResponse {
  batches: RecentBatch[];
}

export interface UndoDeployResultEntry {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface UndoDeployResponse {
  ok: boolean;
  results: UndoDeployResultEntry[];
}

/** Batches Rigel applied within the recent window (Overview "Recent" card). */
export async function fetchRecentDeploys(): Promise<RecentDeploysResponse> {
  const res = await fetch("/api/deployments/recent");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<RecentDeploysResponse>;
}

/** Undo a batch: delete every resource it created. */
export async function undoDeploy(resources: RecentResource[]): Promise<UndoDeployResponse> {
  const res = await fetch("/api/deployments/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resources }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<UndoDeployResponse>;
}

/** Query hook for the Overview "Recent" card. */
export function useRecentDeploys() {
  return useQuery<RecentDeploysResponse, Error>({
    queryKey: ["recent-deploys"],
    queryFn: fetchRecentDeploys,
    staleTime: 30_000,
  });
}

/** Undo mutation; invalidates the recent-deploys query on success. */
export function useUndoDeploy() {
  const qc = useQueryClient();
  return useMutation<UndoDeployResponse, Error, RecentResource[]>({
    mutationFn: undoDeploy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recent-deploys"] }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- api` — Expected: PASS.
Run: `pnpm --filter web typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "feat(web): recent-deploys + undo api helpers and hooks (HELM-60)"
```

---

## Task 8: Design the "Recent" card in Pencil (prerequisite for Task 9)

**Not a code task.** Per the standing "Pencil design first" rule (🔥), the card's visual spec must exist in Pencil before implementation. This is done interactively (author + user), not by a subagent.

- [ ] **Step 1:** In Pencil, design the Overview "Recent" card: the card container/header, a row (`<relative time> · <source label> · <N> resources · namespace <ns>` + an **Undo** button), the empty state, and the destructive Undo confirmation (listing the resources to delete). Capture the frame id(s).
- [ ] **Step 2:** Record the frame id(s) here for Task 9 to reference: `__________`.
- [ ] **Step 3:** No commit (design lives in the `.pen` file).

Source label mapping to use in the design + implementation:
`compose-migration → "Compose migration"`, `catalog-install → "Catalog install"`, `apply-yaml → "Apply YAML"`.

---

## Task 9: Overview "Recent" card + Undo confirm

**Files:**
- Create: `apps/web/src/panels/overview/RecentDeploysCard.tsx`
- Test: `apps/web/src/panels/overview/RecentDeploysCard.test.tsx`
- Modify: `apps/web/src/panels/overview/OverviewPanel.tsx`

**Styling constraint:** Match the Pencil frame from Task 8 exactly. Tailwind utilities + tokens only — no hand-written CSS, no `style={{}}` with raw hex/px (per the design-system rules). Reuse existing Overview card chrome/patterns.

- [ ] **Step 1: Write the failing test (behavior, not pixels)**

```tsx
// apps/web/src/panels/overview/RecentDeploysCard.test.tsx
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentDeploysCard } from "./RecentDeploysCard";
import * as api from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const batch = {
  batchId: "b1",
  source: "compose-migration",
  appliedAt: new Date().toISOString(),
  resources: [
    { kind: "Deployment", name: "web", namespace: "shop" },
    { kind: "Service", name: "web", namespace: "shop" },
  ],
};

describe("RecentDeploysCard", () => {
  test("renders a row per batch with source label + resource count", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [batch] });
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Compose migration/)).toBeInTheDocument();
    expect(screen.getByText(/2 resources/)).toBeInTheDocument();
    expect(screen.getByText(/shop/)).toBeInTheDocument();
  });

  test("shows an empty state when there are no batches", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [] });
    wrap(<RecentDeploysCard />);
    expect(await screen.findByText(/Nothing applied recently/i)).toBeInTheDocument();
  });

  test("Undo opens a confirm then calls undoDeploy with the batch resources", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [batch] });
    const undo = vi.spyOn(api, "undoDeploy").mockResolvedValue({ ok: true, results: [] });
    wrap(<RecentDeploysCard />);

    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));
    // Confirmation appears; confirm it.
    fireEvent.click(await screen.findByRole("button", { name: /delete|confirm|undo/i }));

    await waitFor(() => expect(undo).toHaveBeenCalledWith(batch.resources));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- RecentDeploysCard`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `RecentDeploysCard.tsx`**

Implement to match the Pencil frame. Structural requirements the test locks in (keep these regardless of styling): read data via `useRecentDeploys()`; map each batch to a row showing the source label, `${resources.length} resources`, the namespace(s), and a relative-time string; an **Undo** button per row; an empty state with copy matching `Nothing applied recently`; Undo opens a destructive confirmation that, on confirm, calls `useUndoDeploy().mutate(batch.resources)`.

Reference implementation (adapt styling to the frame):

```tsx
import { useState } from "react";
import { useRecentDeploys, useUndoDeploy } from "@/lib/api";
import type { RecentBatch } from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import { spelledAge } from "@/lib/time"; // shared date-fns wrapper: ISO/epoch → "3 minutes"

const SOURCE_LABEL: Record<string, string> = {
  "compose-migration": "Compose migration",
  "catalog-install": "Catalog install",
  "apply-yaml": "Apply YAML",
};

function namespacesOf(b: RecentBatch): string {
  return [...new Set(b.resources.map((r) => r.namespace).filter(Boolean))].join(", ") || "—";
}

export function RecentDeploysCard() {
  const { data } = useRecentDeploys();
  const undo = useUndoDeploy();
  const [confirming, setConfirming] = useState<RecentBatch | null>(null);
  const batches = data?.batches ?? [];

  return (
    <section /* card chrome per Pencil frame */>
      <header>Recent</header>
      {batches.length === 0 ? (
        <p>Nothing applied recently</p>
      ) : (
        <ul>
          {batches.map((b) => (
            <li key={b.batchId}>
              <span>{spelledAge(b.appliedAt)} ago</span>
              <span>{SOURCE_LABEL[b.source] ?? b.source}</span>
              <span>{b.resources.length} resources</span>
              <span>namespace {namespacesOf(b)}</span>
              <Button variant="destructive" onClick={() => setConfirming(b)}>Undo</Button>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <ConfirmUndo
          batch={confirming}
          pending={undo.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            undo.mutate(confirming.resources, { onSuccess: () => setConfirming(null) });
          }}
        />
      )}
    </section>
  );
}

// Destructive confirmation — style to the Pencil frame; use the project's
// Dialog primitives (ui/dialog.tsx) with a red/destructive confirm button.
function ConfirmUndo(props: {
  batch: RecentBatch;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { batch, pending, onCancel, onConfirm } = props;
  return (
    <div role="dialog" aria-label="Confirm undo">
      <p>Delete {batch.resources.length} resources created by this apply?</p>
      <ul>
        {batch.resources.map((r) => (
          <li key={`${r.kind}/${r.name}/${r.namespace}`}>{r.kind}/{r.name} · {r.namespace}</li>
        ))}
      </ul>
      <Button onClick={onCancel} disabled={pending}>Cancel</Button>
      <Button variant="destructive" onClick={onConfirm} disabled={pending}>Delete</Button>
    </div>
  );
}
```

Note: the relative-time helper is `spelledAge(isoOrEpoch)` from `apps/web/src/lib/time.ts` (returns "3 minutes"; "" for bad input). Do not import `date-fns` directly (per the date-fns consolidation).

- [ ] **Step 4: Mount the card in `OverviewPanel.tsx`**

Add the import:
```ts
import { RecentDeploysCard } from "./RecentDeploysCard";
```
Render it inside the `ov-content` scroll area in its own `ov-row` (place per the Pencil frame — e.g. directly under the header actions row):
```tsx
        <div className="ov-row">
          <RecentDeploysCard />
        </div>
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm --filter web test -- RecentDeploysCard` — Expected: PASS.
Run: `pnpm --filter web typecheck` — Expected: clean.
Run: `pnpm --filter web build` — Expected: success.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/overview/RecentDeploysCard.tsx apps/web/src/panels/overview/RecentDeploysCard.test.tsx apps/web/src/panels/overview/OverviewPanel.tsx
git commit -m "feat(web): Recent deployments card + Undo on Overview (HELM-60)"
```

---

## Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run every affected package's tests**

```bash
pnpm --filter @rigel/k8s test
pnpm --filter @rigel/server test
pnpm --filter web test
```
Expected: all green (note any PRE-EXISTING failures unrelated to this change — e.g. assistant.ts webhook typecheck noise — and confirm they predate the branch).

- [ ] **Step 2: Typecheck + build the web app**

```bash
pnpm --filter @rigel/k8s typecheck || true
pnpm --filter @rigel/server typecheck
pnpm --filter web typecheck
pnpm --filter web build
```
Expected: no NEW type errors; build succeeds.

- [ ] **Step 3: Manual smoke (desktop), only if requested**

Per the "no web dev server" rule, do NOT start Vite. If the user wants a live check, run `pnpm --filter desktop dev`, apply a small manifest via Apply YAML, confirm a "Recent" row appears, click Undo, confirm the resource is deleted. Do NOT curl the mutation routes to "verify wiring."

- [ ] **Step 4: Commit any fixups**, then the branch is ready for review/merge.

---

## Task 11: Docs + tickets (standing workflow)

**Files:** none in-repo (external systems).

- [ ] **Step 1:** Update the app's Outline doc (Rigel collection) with the "Recent deployments / Undo" feature: what it does, the `rigel.dev/apply-batch` / `applied-at` / `apply-source` annotation contract, the 14-day window, and the v1 scope (creations only; helm/edits out).
- [ ] **Step 2:** From that doc, update HELM-60 in Plane (link the Outline doc) and create follow-up tickets for the deferred items: reverting in-place edits, Helm-install undo, a dedicated Recent/Activity panel.

---

## Self-Review Notes

- **Spec coverage:** annotation constants (T1) ✓; apply-then-annotate-created-only stamping (T2, T3) ✓; `source` on `/api/apply` + all three callers (T3, T4) ✓; 14-day discovery grouped by batch (T5, T6) ✓; undo via per-resource delete (T6) ✓; Overview card only (T9) ✓; Pencil-first UI (T8) ✓; out-of-scope items tracked as follow-ups (T11) ✓; docs/tickets workflow (T11) ✓.
- **Field-name collision:** apply-source uses `applySource`, not the pre-existing `ActionBlock.source`. ✓
- **Type consistency:** `ApplySource`, `RecentBatch`, `RecentResource`, `RawRecentItem` defined in `packages/k8s` (T1/T5) and consumed unchanged by server (T3/T6) and web (T4/T7/T9). `canonicalKind`/`deleteArgs`/`DISCOVERY_KINDS` reused from `packages/k8s/src/purge.ts`. ✓
- **Spec deviation (constants location):** documented in the header; convention preserved.
