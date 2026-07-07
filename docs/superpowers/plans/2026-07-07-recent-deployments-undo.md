# Recent deployments / Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a one-click "undo" for anything they applied through Rigel (Compose migration, catalog manifest install, Apply YAML), surfaced as a "Recent" card on Overview.

**Architecture:** An in-cluster batch ledger, Helm-style. At apply time the server writes ONE ConfigMap (`rigel-apply-<batchId>`, in `default`, labelled `rigel.dev/ledger=apply-batch`) recording the batch and the exact list of resources the `kubectl apply` newly *created* (parsed from apply stdout, namespaces resolved from the applied YAML). "Recent" lists ledger ConfigMaps by label within a 14-day window. Undo re-reads the ledger, deletes each recorded resource (`--ignore-not-found`) through the red destructive confirm, then deletes the ledger. Recording is best-effort (a failed ledger write never fails the apply).

**Tech Stack:** TypeScript monorepo. Pure logic + constants in `packages/k8s`; server routes in `apps/server`; React 19 + TanStack Query + Zustand in `apps/web`. Tests: vitest. YAML parsing via the `yaml` package.

**Design notes:**
- Ledger constants live in `packages/k8s` (not `packages/catalog`): they are not catalog-specific and neither `packages/k8s` nor `apps/server` depends on `@rigel/catalog`. The one-constant-plus-single-reader convention from `CATALOG_APP_ANNOTATION`/`boundAppID` is preserved.
- `ActionBlock.source` already exists (it's `proposeRepoFix`'s git source), so the apply-source is threaded on a new distinct field `applySource`.
- Reuses purge's `deleteArgs`, `canonicalKind`, and `DISCOVERY_KINDS` from `packages/k8s/src/purge.ts`.

---

## File Structure

**Created:**
- `packages/k8s/src/applyBatch.ts` — ledger constants (label key/value, name prefix, data key), `ApplySource` type + `asApplySource`, `ledgerName(batchId)`.
- `packages/k8s/src/applyLedger.ts` — pure: parse applied YAML → resources, parse apply stdout → created, resolve created→resources, build the ledger ConfigMap manifest.
- `packages/k8s/src/applyLedger.test.ts`, `packages/k8s/src/applyBatch.test.ts`
- `packages/k8s/src/recentDeploys.ts` — pure: ledger query argv, parse ledger ConfigMaps → windowed batches.
- `packages/k8s/src/recentDeploys.test.ts`
- `apps/server/src/recentDeploys.ts` — `discoverRecent` + `undoBatch` (injectable runners).
- `apps/server/src/recentDeploys.test.ts`
- `apps/web/src/panels/overview/RecentDeploysCard.tsx` — the Overview card + Undo confirm.
- `apps/web/src/panels/overview/RecentDeploysCard.test.tsx`

**Modified:**
- `packages/k8s/src/index.ts` — re-export the new modules.
- `packages/k8s/package.json` — add `yaml` dep.
- `apps/server/src/install.ts` — thread `source` into `applyManifest`, write the ledger after a successful apply.
- `apps/server/src/install.test.ts` — recording tests.
- `apps/server/src/index.ts` — pass `body.source` to `applyManifest`; add `GET /api/deployments/recent` + `POST /api/deployments/undo`.
- `apps/web/src/lib/api.ts` — `applyManifestYaml(yaml, dryRun, source?)`; `applySource` on `ActionBlock`; `fetchRecentDeploys`/`undoDeploy` + hooks.
- `apps/web/src/components/ConfirmSheet.tsx` — pass `act.applySource` to `applyManifestYaml`.
- `apps/web/src/panels/compose/ComposeMigratePanel.tsx` — set `applySource: "compose-migration"`.
- `apps/web/src/panels/apply/ApplyYamlPanel.tsx` — set `applySource: "apply-yaml"`.
- `apps/web/src/panels/catalog/installApi.ts` + `CatalogInstallWizard.tsx` — pass `"catalog-install"`.
- `apps/web/src/panels/overview/OverviewPanel.tsx` — mount `RecentDeploysCard`.

---

## Task 1: Ledger constants + ApplySource

**Files:**
- Create: `packages/k8s/src/applyBatch.ts`
- Test: `packages/k8s/src/applyBatch.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/applyBatch.test.ts
import { describe, expect, test } from "vitest";
import {
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAME_PREFIX,
  LEDGER_DATA_KEY,
  LEDGER_NAMESPACE,
  ledgerName,
  asApplySource,
} from "./applyBatch";

describe("ledger constants", () => {
  test("frozen rigel.dev ledger contract", () => {
    expect(LEDGER_LABEL_KEY).toBe("rigel.dev/ledger");
    expect(LEDGER_LABEL_VALUE).toBe("apply-batch");
    expect(LEDGER_NAME_PREFIX).toBe("rigel-apply-");
    expect(LEDGER_DATA_KEY).toBe("batch.json");
    expect(LEDGER_NAMESPACE).toBe("default");
  });

  test("ledgerName prefixes the batch id", () => {
    expect(ledgerName("abc-123")).toBe("rigel-apply-abc-123");
  });

  test("asApplySource narrows valid values only", () => {
    expect(asApplySource("compose-migration")).toBe("compose-migration");
    expect(asApplySource("catalog-install")).toBe("catalog-install");
    expect(asApplySource("apply-yaml")).toBe("apply-yaml");
    expect(asApplySource("bogus")).toBeNull();
    expect(asApplySource(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- applyBatch`
Expected: FAIL — `Cannot find module './applyBatch'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/applyBatch.ts
// The apply-batch ledger: Rigel records each manifest apply as ONE ConfigMap so
// "Recent deployments" can list it and Undo can delete exactly what the apply
// created. Constants centralized here (one place per contract string), mirroring
// catalog's CATALOG_APP_ANNOTATION convention. Placed in @rigel/k8s (not catalog)
// because they are not catalog-specific.

/** Label selecting ledger ConfigMaps. */
export const LEDGER_LABEL_KEY = "rigel.dev/ledger";
export const LEDGER_LABEL_VALUE = "apply-batch";
/** Ledger ConfigMap name = prefix + batchId. */
export const LEDGER_NAME_PREFIX = "rigel-apply-";
/** The ConfigMap data key holding the batch JSON. */
export const LEDGER_DATA_KEY = "batch.json";
/** Rigel's standard state namespace; all ledgers live here. */
export const LEDGER_NAMESPACE = "default";

/** The Rigel apply surfaces that record a batch. */
export type ApplySource = "compose-migration" | "catalog-install" | "apply-yaml";

const APPLY_SOURCES: readonly ApplySource[] = [
  "compose-migration",
  "catalog-install",
  "apply-yaml",
];

/** Ledger ConfigMap name for a batch id. */
export function ledgerName(batchId: string): string {
  return `${LEDGER_NAME_PREFIX}${batchId}`;
}

/** Narrow an arbitrary string to a valid ApplySource, or null. */
export function asApplySource(v: string | undefined | null): ApplySource | null {
  return v != null && (APPLY_SOURCES as readonly string[]).includes(v) ? (v as ApplySource) : null;
}
```

- [ ] **Step 4: Add re-exports in `packages/k8s/src/index.ts`**

```ts
export {
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAME_PREFIX,
  LEDGER_DATA_KEY,
  LEDGER_NAMESPACE,
  ledgerName,
  asApplySource,
  type ApplySource,
} from "./applyBatch";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- applyBatch`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/applyBatch.ts packages/k8s/src/applyBatch.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): apply-batch ledger constants (HELM-60)"
```

---

## Task 2: Ledger builder (parse applied YAML + apply stdout, build the ConfigMap)

**Files:**
- Create: `packages/k8s/src/applyLedger.ts`
- Test: `packages/k8s/src/applyLedger.test.ts`
- Modify: `packages/k8s/package.json` (add `yaml`), `packages/k8s/src/index.ts`

- [ ] **Step 1: Add the `yaml` dependency**

In `packages/k8s/package.json`, add to `dependencies` (match `packages/compose/package.json`):

```json
"yaml": "latest"
```

Then: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// packages/k8s/src/applyLedger.test.ts
import { describe, expect, test } from "vitest";
import {
  parseAppliedResources,
  parseCreatedResources,
  resolveCreatedResources,
  buildLedgerManifest,
} from "./applyLedger";

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

  test("ignores empty/null docs and docs missing kind or name", () => {
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

describe("resolveCreatedResources", () => {
  test("maps created (kind,name) to manifest kind + resolved namespace (default when omitted)", () => {
    const resources = resolveCreatedResources(parseCreatedResources(STDOUT), parseAppliedResources(YAML));
    expect(resources).toEqual([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
      { kind: "PersistentVolumeClaim", name: "web-data", namespace: "default" },
    ]);
  });
});

describe("buildLedgerManifest", () => {
  test("builds the ledger ConfigMap object with batch.json payload", () => {
    const resources = [{ kind: "Deployment", name: "web", namespace: "shop" }];
    const cm = buildLedgerManifest(
      { batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "compose-migration" },
      resources,
    );
    expect(cm.apiVersion).toBe("v1");
    expect(cm.kind).toBe("ConfigMap");
    expect(cm.metadata).toEqual({
      name: "rigel-apply-b1",
      namespace: "default",
      labels: { "rigel.dev/ledger": "apply-batch" },
    });
    expect(JSON.parse(cm.data["batch.json"])).toEqual({
      batchId: "b1",
      appliedAt: "2026-07-07T10:00:00.000Z",
      source: "compose-migration",
      resources,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- applyLedger`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/k8s/src/applyLedger.ts
// Pure helpers for building an apply-batch ledger from a `kubectl apply`. Kept
// pure (no process spawning) so the ConfigMap manifest + argv are unit-testable;
// the server (install.ts) writes the returned manifest via `kubectl apply -f -`.

import { parseAllDocuments } from "yaml";
import {
  LEDGER_DATA_KEY,
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAMESPACE,
  ledgerName,
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

export interface LedgerResource {
  kind: string; // manifest kind, e.g. "Deployment"
  name: string;
  namespace: string; // resolved ("default" when the manifest omitted it)
}

export interface LedgerMeta {
  batchId: string;
  appliedAt: string;
  source: ApplySource;
}

export interface LedgerConfigMap {
  apiVersion: "v1";
  kind: "ConfigMap";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  data: Record<string, string>;
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
 * Parse `kubectl apply` stdout, keeping only resources it reported as `created`.
 * Lines look like `deployment.apps/web created` or `service/web created`; the
 * kind is the token before the first `.` or `/`.
 */
export function parseCreatedResources(stdout: string): CreatedResource[] {
  const out: CreatedResource[] = [];
  for (const raw of stdout.split("\n")) {
    const m = /^(\S+?)\/(\S+)\s+created$/.exec(raw.trim());
    if (!m) continue;
    out.push({ kind: m[1]!.split(".")[0]!.toLowerCase(), name: m[2]! });
  }
  return out;
}

/**
 * Join created resources to their manifest entries: keep the manifest kind
 * (e.g. "Deployment") and resolve namespace to the manifest's, or "default" when
 * omitted (the namespace kubectl applied into). Created resources with no
 * matching manifest entry are skipped.
 */
export function resolveCreatedResources(
  created: CreatedResource[],
  applied: AppliedResource[],
): LedgerResource[] {
  const byKey = new Map<string, AppliedResource>();
  for (const r of applied) byKey.set(`${r.kind.toLowerCase()}/${r.name}`, r);

  const out: LedgerResource[] = [];
  for (const c of created) {
    const match = byKey.get(`${c.kind}/${c.name}`);
    if (!match) continue;
    out.push({ kind: match.kind, name: match.name, namespace: match.namespace ?? "default" });
  }
  return out;
}

/** Build the ledger ConfigMap manifest for a batch. */
export function buildLedgerManifest(meta: LedgerMeta, resources: LedgerResource[]): LedgerConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: ledgerName(meta.batchId),
      namespace: LEDGER_NAMESPACE,
      labels: { [LEDGER_LABEL_KEY]: LEDGER_LABEL_VALUE },
    },
    data: {
      [LEDGER_DATA_KEY]: JSON.stringify({
        batchId: meta.batchId,
        appliedAt: meta.appliedAt,
        source: meta.source,
        resources,
      }),
    },
  };
}
```

- [ ] **Step 5: Add re-exports in `packages/k8s/src/index.ts`**

```ts
export {
  parseAppliedResources,
  parseCreatedResources,
  resolveCreatedResources,
  buildLedgerManifest,
  type AppliedResource,
  type CreatedResource,
  type LedgerResource,
  type LedgerMeta,
  type LedgerConfigMap,
} from "./applyLedger";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- applyLedger`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/k8s/src/applyLedger.ts packages/k8s/src/applyLedger.test.ts packages/k8s/src/index.ts packages/k8s/package.json
git commit -m "feat(k8s): apply-batch ledger builder (HELM-60)"
```

---

## Task 3: Write the ledger from `applyManifest`

**Files:**
- Modify: `apps/server/src/install.ts`
- Test: `apps/server/src/install.test.ts`
- Modify: `apps/server/src/index.ts` (pass `body.source`)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/install.test.ts` (top import: `import { applyManifest } from "./install";` plus vitest helpers):

```ts
import { describe, expect, test, vi } from "vitest";

describe("applyManifest ledger recording", () => {
  const yaml = ["apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: web", "  namespace: shop"].join("\n");

  test("writes a ledger ConfigMap for created resources when source is given", async () => {
    const applyRun = vi.fn().mockResolvedValue({ code: 0, stdout: "deployment.apps/web created", stderr: "" });
    const ledgerRun = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const res = await applyManifest(null, yaml, false, "compose-migration", {
      applyRun,
      ledgerRun,
      idGen: () => "batch-1",
      clock: () => new Date("2026-07-07T10:00:00.000Z"),
    });

    expect(res.code).toBe(0);
    expect(res.batchId).toBe("batch-1");
    expect(ledgerRun).toHaveBeenCalledTimes(1);
    const [ctx, manifestJson] = ledgerRun.mock.calls[0]!;
    expect(ctx).toBeNull();
    const cm = JSON.parse(manifestJson as string);
    expect(cm.metadata.name).toBe("rigel-apply-batch-1");
    expect(cm.metadata.labels).toEqual({ "rigel.dev/ledger": "apply-batch" });
    expect(JSON.parse(cm.data["batch.json"])).toEqual({
      batchId: "batch-1",
      appliedAt: "2026-07-07T10:00:00.000Z",
      source: "compose-migration",
      resources: [{ kind: "Deployment", name: "web", namespace: "shop" }],
    });
  });

  test("does not write a ledger on dryRun / missing source / invalid source / apply failure / nothing created", async () => {
    const ledgerRun = vi.fn();
    const created = { code: 0, stdout: "deployment.apps/web created", stderr: "" };
    const base = { ledgerRun, idGen: () => "b", clock: () => new Date(0) };

    await applyManifest(null, yaml, true, "compose-migration", { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, undefined, { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, "bogus", { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, "compose-migration", { applyRun: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" }), ...base });
    await applyManifest(null, yaml, false, "compose-migration", { applyRun: vi.fn().mockResolvedValue({ code: 0, stdout: "deployment.apps/web configured", stderr: "" }), ...base });

    expect(ledgerRun).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test -- install`
Expected: FAIL — `applyManifest` doesn't accept source/deps, `res.batchId` undefined, ledger never written.

- [ ] **Step 3: Rewrite `applyManifest` in `apps/server/src/install.ts`**

Extend the imports at the top:

```ts
import { buildKubectlArgs, runProcess, runProcessWithStdin, type RunResult } from "@rigel/k8s/src/run";
import {
  asApplySource,
  buildLedgerManifest,
  parseAppliedResources,
  parseCreatedResources,
  resolveCreatedResources,
} from "@rigel/k8s";
import { randomUUID } from "node:crypto";
```

Replace `applyManifest` (lines 31-38) with:

```ts
export interface ApplyResult extends RunResult {
  /** Set when this apply created resources and recorded a ledger batch. */
  batchId?: string;
}

/** Injectable runners/clock so ledger recording is testable without kubectl. */
export interface ApplyDeps {
  applyRun: (context: string | null, argv: string[], stdin: string) => Promise<RunResult>;
  ledgerRun: (context: string | null, manifestJson: string) => Promise<RunResult>;
  idGen: () => string;
  clock: () => Date;
}

const defaultApplyDeps: ApplyDeps = {
  applyRun: (context, argv, stdin) => runProcessWithStdin("kubectl", buildKubectlArgs(context, argv), stdin),
  ledgerRun: (context, manifestJson) =>
    runProcessWithStdin("kubectl", buildKubectlArgs(context, ["apply", "-f", "-"]), manifestJson),
  idGen: () => randomUUID(),
  clock: () => new Date(),
};

/**
 * Run `kubectl apply -f -` feeding `yaml` on STDIN. When `source` is a valid
 * ApplySource and this is not a dryRun, the resources the apply reported as
 * `created` are recorded in a ledger ConfigMap (best-effort: a ledger-write
 * failure does not fail the apply). Returns the apply result plus `batchId`.
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

  const resources = resolveCreatedResources(parseCreatedResources(result.stdout), parseAppliedResources(yaml));
  if (resources.length === 0) return result;

  const batchId = deps.idGen();
  const cm = buildLedgerManifest({ batchId, appliedAt: deps.clock().toISOString(), source: applySource }, resources);
  await deps.ledgerRun(context, JSON.stringify(cm)); // best-effort
  return { ...result, batchId };
}
```

Note: `buildApplyArgs` (lines 21-23) is still exported/used by other tests — leave it.

- [ ] **Step 4: Pass `source` through the `/api/apply` route in `apps/server/src/index.ts`**

Update the `/api/apply` handler (around line 448-457):

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

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @rigel/server test -- install` — Expected: PASS.
Run: `pnpm --filter @rigel/server typecheck` — Expected: no NEW errors in install.ts/index.ts (pre-existing assistant.ts noise, if any, is unrelated).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/install.ts apps/server/src/install.test.ts apps/server/src/index.ts
git commit -m "feat(server): record an apply-batch ledger on manifest apply (HELM-60)"
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
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: false, source: "compose-migration" });
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
Expected: FAIL — `source` not in body.

- [ ] **Step 3: Update `applyManifestYaml` + `ActionBlock` in `apps/web/src/lib/api.ts`**

Add the type import near the top:
```ts
import type { ApplySource } from "@rigel/k8s";
```
Replace `applyManifestYaml` (lines 93-104):
```ts
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
  /** applyManifest only — which Rigel surface triggered the apply (ledger recording). */
  applySource?: ApplySource;
```
Add optional `batchId` to `ActionResult` (after line 48):
```ts
  /** applyManifest only — set when the apply created resources and recorded a batch. */
  batchId?: string;
```

- [ ] **Step 4: Pass `applySource` from `ConfirmSheet.handleApply`**

In `apps/web/src/components/ConfirmSheet.tsx`, in `handleApply()` (line ~142) change:
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

`apps/web/src/panels/apply/ApplyYamlPanel.tsx` line 55, add `applySource: "apply-yaml"`:
```ts
    setPendingAction({ kind: "applyManifest", label: "Apply YAML", manifest: yaml, applySource: "apply-yaml" });
```

- [ ] **Step 6: Pass source through the catalog manifest install**

`apps/web/src/panels/catalog/installApi.ts`, replace `applyManifest` + `useApplyManifest`:
```ts
import type { ApplySource } from "@rigel/k8s";

export function applyManifest(yaml: string, source?: ApplySource): Promise<InstallResult> {
  return postJSON<InstallResult>("/api/apply", { yaml, ...(source ? { source } : {}) });
}

export function useApplyManifest() {
  return useMutation<InstallResult, Error, { yaml: string; source?: ApplySource }>({
    mutationFn: ({ yaml, source }) => applyManifest(yaml, source),
  });
}
```
In `apps/web/src/panels/catalog/CatalogInstallWizard.tsx` (line ~199): if it calls `applyManifest(artifact)` directly, change to `applyManifest(artifact, "catalog-install")`; if it uses the `useApplyManifest` mutation, call `.mutateAsync({ yaml: artifact, source: "catalog-install" })`. Match the wizard's actual usage.

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter web test -- api` — Expected: PASS.
Run: `pnpm --filter web typecheck` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/components/ConfirmSheet.tsx apps/web/src/panels/compose/ComposeMigratePanel.tsx apps/web/src/panels/apply/ApplyYamlPanel.tsx apps/web/src/panels/catalog/installApi.ts apps/web/src/panels/catalog/CatalogInstallWizard.tsx
git commit -m "feat(web): tag Rigel applies with their source for ledger recording (HELM-60)"
```

---

## Task 5: Recent-deploys discovery (pure ledger parsing)

**Files:**
- Create: `packages/k8s/src/recentDeploys.ts`
- Test: `packages/k8s/src/recentDeploys.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/recentDeploys.test.ts
import { describe, expect, test } from "vitest";
import { RECENT_WINDOW_MS, ledgerDiscoveryArgs, parseLedgerBatches } from "./recentDeploys";

const now = Date.parse("2026-07-07T12:00:00.000Z");
const recent = "2026-07-07T10:00:00.000Z";
const old = "2026-06-01T10:00:00.000Z"; // > 14 days ago

function cm(batch: object) {
  return { data: { "batch.json": JSON.stringify(batch) } };
}

describe("ledgerDiscoveryArgs", () => {
  test("selects ledger ConfigMaps by label in the ledger namespace as json", () => {
    expect(ledgerDiscoveryArgs()).toEqual([
      "get", "configmap", "-n", "default", "-l", "rigel.dev/ledger=apply-batch", "-o", "json",
    ]);
  });
});

describe("parseLedgerBatches", () => {
  test("parses in-window ledgers, newest first", () => {
    const items = [
      cm({ batchId: "b1", appliedAt: recent, source: "compose-migration", resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] }),
      cm({ batchId: "b2", appliedAt: "2026-07-07T11:00:00.000Z", source: "apply-yaml", resources: [{ kind: "Service", name: "api", namespace: "shop" }] }),
    ];
    expect(parseLedgerBatches(items, now, RECENT_WINDOW_MS)).toEqual([
      { batchId: "b2", source: "apply-yaml", appliedAt: "2026-07-07T11:00:00.000Z", resources: [{ kind: "Service", name: "api", namespace: "shop" }] },
      { batchId: "b1", source: "compose-migration", appliedAt: recent, resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] },
    ]);
  });

  test("drops out-of-window ledgers and unparseable payloads", () => {
    const items = [
      cm({ batchId: "b0", appliedAt: old, source: "apply-yaml", resources: [] }),
      { data: { "batch.json": "not json" } },
      { data: {} },
    ];
    expect(parseLedgerBatches(items, now, RECENT_WINDOW_MS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test -- recentDeploys`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/recentDeploys.ts
// Pure discovery for "Recent deployments": list ledger ConfigMaps and parse their
// batch.json payloads into windowed, newest-first batches. No process spawning —
// the server (recentDeploys.ts) runs the query and calls parseLedgerBatches.

import {
  LEDGER_DATA_KEY,
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAMESPACE,
} from "./applyBatch";

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

/** A ledger ConfigMap item from `kubectl get configmap … -o json` `.items`. */
export interface LedgerItem {
  data?: Record<string, string>;
}

/** Build the kubectl argv (verb onward) selecting ledger ConfigMaps. */
export function ledgerDiscoveryArgs(): string[] {
  return [
    "get", "configmap", "-n", LEDGER_NAMESPACE,
    "-l", `${LEDGER_LABEL_KEY}=${LEDGER_LABEL_VALUE}`, "-o", "json",
  ];
}

/**
 * Parse ledger ConfigMaps into batches within `windowMs` of `nowMs`, newest
 * first. Unparseable or out-of-window ledgers are dropped. `nowMs` is injected
 * for testability.
 */
export function parseLedgerBatches(
  items: LedgerItem[],
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): RecentBatch[] {
  const batches: RecentBatch[] = [];
  for (const it of items) {
    const raw = it.data?.[LEDGER_DATA_KEY];
    if (!raw) continue;
    let batch: RecentBatch;
    try {
      batch = JSON.parse(raw) as RecentBatch;
    } catch {
      continue;
    }
    if (!batch?.batchId || !batch.appliedAt) continue;
    const ts = Date.parse(batch.appliedAt);
    if (Number.isNaN(ts) || nowMs - ts > windowMs) continue;
    batches.push({
      batchId: batch.batchId,
      source: batch.source ?? "",
      appliedAt: batch.appliedAt,
      resources: Array.isArray(batch.resources) ? batch.resources : [],
    });
  }
  return batches.sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
}
```

- [ ] **Step 4: Add re-exports in `packages/k8s/src/index.ts`**

```ts
export {
  RECENT_WINDOW_MS,
  ledgerDiscoveryArgs,
  parseLedgerBatches,
  type RecentBatch,
  type RecentResource,
  type LedgerItem,
} from "./recentDeploys";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test -- recentDeploys`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/recentDeploys.ts packages/k8s/src/recentDeploys.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): recent-deploys ledger discovery (HELM-60)"
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
  test("lists ledger ConfigMaps and returns windowed batches", async () => {
    const items = {
      items: [
        { data: { "batch.json": JSON.stringify({ batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "compose-migration", resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] }) } },
      ],
    };
    const kubectlRun = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(items), stderr: "" });
    const res = await discoverRecent(null, Date.parse("2026-07-07T12:00:00.000Z"), { kubectlRun });
    expect(kubectlRun.mock.calls[0]![1]).toEqual(["get", "configmap", "-n", "default", "-l", "rigel.dev/ledger=apply-batch", "-o", "json"]);
    expect(res.batches).toHaveLength(1);
    expect(res.batches[0]!.batchId).toBe("b1");
  });

  test("returns empty on query failure", async () => {
    const kubectlRun = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    expect((await discoverRecent(null, Date.now(), { kubectlRun })).batches).toEqual([]);
  });
});

describe("undoBatch", () => {
  const ledger = {
    items: undefined,
    data: { "batch.json": JSON.stringify({ batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "apply-yaml", resources: [
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
    ] }) },
  };

  test("reads the ledger, deletes each resource (ignore-not-found), then deletes the ledger", async () => {
    const kubectlRun = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(ledger), stderr: "" }) // get ledger
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // delete deployment
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // delete service
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // delete ledger cm

    const res = await undoBatch(null, "b1", { kubectlRun });

    expect(kubectlRun.mock.calls[0]![1]).toEqual(["get", "configmap", "rigel-apply-b1", "-n", "default", "-o", "json"]);
    expect(kubectlRun.mock.calls[1]![1]).toEqual(["delete", "deployment", "web", "-n", "shop", "--ignore-not-found"]);
    expect(kubectlRun.mock.calls[2]![1]).toEqual(["delete", "service", "web", "-n", "shop", "--ignore-not-found"]);
    expect(kubectlRun.mock.calls[3]![1]).toEqual(["delete", "configmap", "rigel-apply-b1", "-n", "default", "--ignore-not-found"]);
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([
      { resource: "Deployment/web", ok: true, detail: "deleted" },
      { resource: "Service/web", ok: true, detail: "deleted" },
    ]);
  });

  test("errors when the ledger is missing", async () => {
    const kubectlRun = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" });
    const res = await undoBatch(null, "gone", { kubectlRun });
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([{ resource: "batch/gone", ok: false, detail: "ledger not found" }]);
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
//   GET  /api/deployments/recent → list ledger ConfigMaps, parse into batches.
//   POST /api/deployments/undo   → re-read a batch's ledger, delete each
//        recorded resource (ignore-not-found), then delete the ledger.
// Binaries spawn via argv arrays (no shell); --context is prepended by kubectl.

import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  LEDGER_DATA_KEY,
  LEDGER_NAMESPACE,
  canonicalKind,
  deleteArgs,
  ledgerDiscoveryArgs,
  ledgerName,
  parseLedgerBatches,
  type LedgerItem,
  type RecentBatch,
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

/** List ledger ConfigMaps and return windowed, newest-first batches. */
export async function discoverRecent(
  context: string | null,
  nowMs: number,
  runners: RecentRunners = defaultRunners,
): Promise<DiscoverRecentResponse> {
  const res = await runners.kubectlRun(context, ledgerDiscoveryArgs());
  if (res.code !== 0) return { batches: [] };
  let items: LedgerItem[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as { items?: LedgerItem[] };
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return { batches: [] };
  }
  return { batches: parseLedgerBatches(items, nowMs) };
}

/** Delete every resource recorded in a batch's ledger, then delete the ledger. */
export async function undoBatch(
  context: string | null,
  batchId: string,
  runners: RecentRunners = defaultRunners,
): Promise<UndoResponse> {
  // 1. Re-read the ledger (authoritative resource list).
  const cmName = ledgerName(batchId);
  const get = await runners.kubectlRun(context, ["get", "configmap", cmName, "-n", LEDGER_NAMESPACE, "-o", "json"]);
  if (get.code !== 0) {
    return { ok: false, results: [{ resource: `batch/${batchId}`, ok: false, detail: "ledger not found" }] };
  }
  let resources: RecentBatch["resources"] = [];
  try {
    const cm = JSON.parse(get.stdout) as { data?: Record<string, string> };
    const batch = JSON.parse(cm.data?.[LEDGER_DATA_KEY] ?? "{}") as RecentBatch;
    resources = Array.isArray(batch.resources) ? batch.resources : [];
  } catch {
    return { ok: false, results: [{ resource: `batch/${batchId}`, ok: false, detail: "ledger unreadable" }] };
  }

  // 2. Delete each recorded resource (ignore-not-found → safe no-op).
  const results: UndoResultEntry[] = [];
  for (const r of resources) {
    const resource = `${r.kind}/${r.name}`;
    const kind = canonicalKind(r.kind);
    if (!kind) {
      results.push({ resource, ok: false, detail: "skipped — unsupported kind" });
      continue;
    }
    const del = await runners.kubectlRun(context, [...deleteArgs(kind, r.name, r.namespace), "--ignore-not-found"]);
    const ok = del.code === 0;
    results.push({ resource, ok, detail: ok ? "deleted" : (del.stderr.trim() || `exit ${del.code}`) });
  }

  // 3. Delete the ledger itself so the batch leaves Recent.
  await runners.kubectlRun(context, ["delete", "configmap", cmName, "-n", LEDGER_NAMESPACE, "--ignore-not-found"]);

  return { ok: results.every((r) => r.ok), results };
}
```

- [ ] **Step 4: Register the routes in `apps/server/src/index.ts`**

Add near the other route imports:
```ts
import { discoverRecent, undoBatch } from "./recentDeploys";
```
Add the handlers (alongside the other `/api/*` routes, e.g. after `/api/purge`):
```ts
    // GET /api/deployments/recent — apply batches within the 14-day window.
    if (url.pathname === "/api/deployments/recent" && req.method === "GET") {
      return Response.json(await discoverRecent(context, Date.now()));
    }

    // POST /api/deployments/undo — delete every resource a batch created. Body: { batchId }.
    if (url.pathname === "/api/deployments/undo" && req.method === "POST") {
      let body: { batchId?: string };
      try {
        body = (await req.json()) as { batchId?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.batchId !== "string" || body.batchId === "") {
        return Response.json({ error: "missing batchId" }, { status: 422 });
      }
      return Response.json(await undoBatch(context, body.batchId));
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
    expect(await fetchRecentDeploys()).toEqual({ batches: [] });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/deployments/recent");
  });

  test("undoDeploy POSTs the batchId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }));
    await undoDeploy("b1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/deployments/undo");
    expect(JSON.parse(init!.body as string)).toEqual({ batchId: "b1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- api`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add helpers + hooks to `apps/web/src/lib/api.ts`**

```ts
import type { RecentBatch } from "@rigel/k8s";

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

/** Undo a batch by id: delete every resource it created. */
export async function undoDeploy(batchId: string): Promise<UndoDeployResponse> {
  const res = await fetch("/api/deployments/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId }),
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
  return useMutation<UndoDeployResponse, Error, string>({
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

  test("Undo opens a confirm then calls undoDeploy with the batch id", async () => {
    vi.spyOn(api, "fetchRecentDeploys").mockResolvedValue({ batches: [batch] });
    const undo = vi.spyOn(api, "undoDeploy").mockResolvedValue({ ok: true, results: [] });
    wrap(<RecentDeploysCard />);
    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete|confirm|undo/i }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("b1"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- RecentDeploysCard`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `RecentDeploysCard.tsx`**

Implement to match the Pencil frame. Structural requirements the test locks in (keep regardless of styling): read via `useRecentDeploys()`; one row per batch showing the source label, `${resources.length} resources`, the namespace(s), and a relative time; an **Undo** button per row; an empty state with copy matching `Nothing applied recently`; Undo opens a destructive confirmation that on confirm calls `useUndoDeploy().mutate(batch.batchId)`.

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
          onConfirm={() => undo.mutate(confirming.batchId, { onSuccess: () => setConfirming(null) })}
        />
      )}
    </section>
  );
}

// Destructive confirmation — style to the Pencil frame; use the project's Dialog
// primitives (ui/dialog.tsx) with a red/destructive confirm button.
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
Render it inside the `ov-content` scroll area in its own `ov-row` (place per the Pencil frame):
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
Expected: all green (note any PRE-EXISTING failures unrelated to this change and confirm they predate the branch).

- [ ] **Step 2: Typecheck + build the web app**

```bash
pnpm --filter @rigel/k8s typecheck || true
pnpm --filter @rigel/server typecheck
pnpm --filter web typecheck
pnpm --filter web build
```
Expected: no NEW type errors; build succeeds.

- [ ] **Step 3: Manual smoke (desktop), only if requested**

Per the "no web dev server" rule, do NOT start Vite. If the user wants a live check, run `pnpm --filter desktop dev`, apply a small manifest via Apply YAML, confirm a "Recent" row appears, verify a `rigel-apply-*` ConfigMap exists in `default`, click Undo, confirm the resource AND the ledger ConfigMap are gone. Do NOT curl the mutation routes to "verify wiring."

- [ ] **Step 4: Commit any fixups**, then the branch is ready for review/merge.

---

## Task 11: Docs + tickets (standing workflow)

**Files:** none in-repo (external systems).

- [ ] **Step 1:** Update the app's Outline doc (Rigel collection) with "Recent deployments / Undo": what it does, the in-cluster ledger model (`rigel-apply-*` ConfigMaps in `default`, labelled `rigel.dev/ledger=apply-batch`, `batch.json` payload), the 14-day window, and the v1 scope (creations only; helm/edits out).
- [ ] **Step 2:** From that doc, update HELM-60 in Plane (link the Outline doc) and create follow-up tickets: reverting in-place edits (store prior manifest in the ledger), Helm-install undo, a dedicated Recent/Activity panel, GC of expired ledger ConfigMaps.

---

## Self-Review Notes

- **Spec coverage:** ledger constants (T1) ✓; parse-created + build-ledger (T2) ✓; record-on-apply best-effort + `source` passthrough (T3) ✓; all three web apply callers tagged (T4) ✓; ledger discovery within 14-day window (T5, T6) ✓; undo re-reads ledger, deletes resources with `--ignore-not-found`, deletes ledger (T6) ✓; Overview card only (T9) ✓; Pencil-first UI (T8) ✓; deferred items tracked (T11) ✓.
- **Field-name collision:** apply-source uses `applySource`, not the pre-existing `ActionBlock.source`. ✓
- **Type consistency:** `ApplySource`, `LedgerResource`/`RecentResource`, `RecentBatch`, `LedgerItem`, `LedgerConfigMap` defined in `packages/k8s` and consumed unchanged by server (T3/T6) and web (T4/T7/T9). `canonicalKind`/`deleteArgs` reused from purge. `LEDGER_NAMESPACE`/`ledgerName`/`LEDGER_DATA_KEY` used consistently across builder, discovery, and undo. ✓
- **Robustness vs annotations:** one ledger write per apply (not N); discovery is a single label-selected list (no cluster-wide scan); undo re-reads the authoritative ledger and tolerates not-found; GitOps drift on workload resources does not touch the ledger object. ✓
