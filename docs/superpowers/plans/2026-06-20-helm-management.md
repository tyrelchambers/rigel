# Helm Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Helm tab to Rigel with a Releases lifecycle manager (list, history, values, manifest, rollback/upgrade/uninstall) and a custom-chart install flow (repo URL, OCI ref, Artifact Hub search, local .tgz/folder), plus a shared segmented-rail tab component.

**Architecture:** Releases are derived client-side from the already-watched Secrets (`sh.helm.release.v1.*`), decoded in a pure shared module. All Helm argv construction lives in `packages/k8s/src/helm.ts` so both the server (execution) and web (command preview in a confirm Dialog) use the same builders. Mutations go through new `POST /api/helm/*` Hono routes that shell to the real `helm` binary. Every confirm/preview/form window is a **Dialog/Modal**, never a Sheet.

**Tech Stack:** TypeScript, React 19 + Vite, React Router v7, Zustand, TanStack Query v5, Hono (Node server), vitest, fflate (gzip), Monaco (`YamlEditor`), Electron (file dialog IPC).

**Spec:** `docs/superpowers/specs/2026-06-20-helm-management-design.md`

---

## Conventions for this plan

- **UI windows are Dialogs.** Use `Modal` from `apps/web/src/components/ui/modal.tsx` (built on `dialog.tsx`) for confirms and forms. Do NOT use shadcn Sheet or mirror `components/ConfirmSheet.tsx`.
- **Pure logic is TDD'd with vitest** (the house style: `test("…", () => expect(...).toEqual(...))`). React components are NOT unit-tested in this repo; verify them with `pnpm --filter web typecheck` and `pnpm --filter web build`.
- **Run from repo root** `/Users/tyrelchambers/home/claude-k8s`.
- Commit after each task with the message shown.

## File structure (created / modified)

Created:
- `packages/k8s/src/helm.ts` — release-secret decode, release grouping, all helm argv builders.
- `packages/k8s/src/helm.test.ts` — decode + grouping + argv tests.
- `apps/server/src/artifactHub.ts` — Artifact Hub search client.
- `apps/server/src/artifactHub.test.ts` — search-response parse test.
- `apps/web/src/components/ui/SegmentedTabs.tsx` — shared segmented-rail tabs.
- `apps/web/src/panels/helm/helmApi.ts` — web hooks (mutations + queries).
- `apps/web/src/panels/helm/releases.ts` — pure release-derivation helpers.
- `apps/web/src/panels/helm/releases.test.ts` — derivation tests.
- `apps/web/src/panels/helm/HelmPanel.tsx` — panel shell with the two sub-views.
- `apps/web/src/panels/helm/ReleasesView.tsx` — releases list + detail.
- `apps/web/src/panels/helm/InstallChartView.tsx` — custom-chart install form.
- `apps/web/src/panels/helm/HelmConfirmModal.tsx` — Dialog showing the exact helm command.

Modified:
- `packages/k8s/package.json` — add `fflate` dep.
- `apps/server/src/install.ts` — use shared argv builders; add OCI + local source modes.
- `apps/server/src/install.test.ts` — extend for new source modes.
- `apps/server/src/index.ts` — new `/api/helm/*` routes.
- `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts` — chart file-open IPC.
- `apps/web/src/shell/NavStrip.tsx` — Helm entry in `PANEL_META` + `NAV_GROUPS`.
- `apps/web/src/App.tsx` — `/helm` route.
- `apps/web/src/components/ui/modal.tsx` — `TabModal` uses `SegmentedTabs`.
- `apps/web/src/panels/catalog/CatalogPanel.tsx` + `apps/web/src/index.css` — scope control uses `SegmentedTabs`; drop `.catalog-scope-control` CSS.
- `apps/web/src/types.ts` (or the global `window.rigel` typing location) — add `openChartFile`.

---

## Phase 1: Shared helm module (decode + argv) — `packages/k8s/src/helm.ts`

### Task 1: Add fflate dependency

**Files:**
- Modify: `packages/k8s/package.json`

- [ ] **Step 1: Add the dep**

Run:
```bash
pnpm --filter @rigel/k8s add fflate
```
Expected: `fflate` appears under `dependencies` in `packages/k8s/package.json` (latest, e.g. `^0.8.2`).

- [ ] **Step 2: Commit**

```bash
git add packages/k8s/package.json pnpm-lock.yaml
git commit -m "build(k8s): add fflate for helm release gunzip"
```

### Task 2: Release-secret types + decode

**Files:**
- Create: `packages/k8s/src/helm.ts`
- Create: `packages/k8s/src/helm.test.ts`

- [ ] **Step 1: Write the failing test**

The Helm release Secret stores `data.release = base64(base64(gzip(json)))`. The test builds that encoding with fflate and asserts the decode round-trips. Create `packages/k8s/src/helm.test.ts`:

```typescript
import { test, expect } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { decodeReleaseSecret, type HelmReleasePayload } from "./helm";

/** Encode a release object the way Helm v3 stores it in a Secret's data.release. */
function encodeRelease(payload: unknown): string {
  const json = JSON.stringify(payload);
  const gz = gzipSync(strToU8(json));
  let bin = "";
  for (const b of gz) bin += String.fromCharCode(b);
  const helmB64 = btoa(bin);        // base64(gzip(json)) — Helm's stored string
  return btoa(helmB64);             // base64 again — Kubernetes Secret data encoding
}

const SAMPLE: HelmReleasePayload = {
  name: "my-app",
  namespace: "apps",
  version: 2,
  info: {
    status: "deployed",
    first_deployed: "2026-06-01T00:00:00Z",
    last_deployed: "2026-06-10T00:00:00Z",
    description: "Upgrade complete",
    notes: "Thanks for installing my-app",
  },
  chart: { metadata: { name: "my-app", version: "1.2.3", appVersion: "4.5.6" }, values: { replicas: 1 } },
  config: { replicas: 3 },
  manifest: "apiVersion: v1\nkind: ConfigMap\n",
};

test("decodeReleaseSecret round-trips a gzipped release payload", () => {
  const encoded = encodeRelease(SAMPLE);
  const decoded = decodeReleaseSecret(encoded);
  expect(decoded).not.toBeNull();
  expect(decoded!.name).toBe("my-app");
  expect(decoded!.version).toBe(2);
  expect(decoded!.info.status).toBe("deployed");
  expect(decoded!.chart.metadata.version).toBe("1.2.3");
  expect(decoded!.config).toEqual({ replicas: 3 });
  expect(decoded!.manifest).toContain("kind: ConfigMap");
});

test("decodeReleaseSecret returns null on garbage", () => {
  expect(decodeReleaseSecret("not-base64-!@#")).toBeNull();
  expect(decodeReleaseSecret("")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: FAIL — `decodeReleaseSecret` is not exported from `./helm`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/k8s/src/helm.ts`:

```typescript
// Helm release reading + argv construction, shared by the server (execution)
// and the web app (live release derivation + command preview).
import { gunzipSync, strFromU8 } from "fflate";

export interface HelmReleasePayload {
  name: string;
  namespace: string;
  version: number;
  info: {
    status: string;
    first_deployed?: string;
    last_deployed?: string;
    description?: string;
    notes?: string;
  };
  chart: { metadata: { name: string; version: string; appVersion?: string }; values?: unknown };
  config?: unknown;
  manifest?: string;
}

/**
 * Decode a Helm v3 release Secret's `data.release` value. Helm stores the
 * release as base64(gzip(JSON)); Kubernetes then base64-encodes the Secret
 * value again, so the input is double-base64'd. The gzip magic is checked so a
 * (rare) ungzipped payload still decodes. Returns null on any malformed input.
 */
export function decodeReleaseSecret(release: string): HelmReleasePayload | null {
  try {
    const helmB64 = atob(release);               // -> base64(gzip(json))
    const binary = atob(helmB64);                // -> gzip(json) as a binary string
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const json = gzipped ? strFromU8(gunzipSync(bytes)) : binary;
    return JSON.parse(json) as HelmReleasePayload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/helm.ts packages/k8s/src/helm.test.ts
git commit -m "feat(k8s): decode helm release secrets"
```

### Task 3: Group revision secrets into releases

**Files:**
- Modify: `packages/k8s/src/helm.ts`
- Modify: `packages/k8s/src/helm.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/k8s/src/helm.test.ts`:

```typescript
import { groupReleases, type ReleaseSecret } from "./helm";

function secret(name: string, namespace: string, payload: Partial<HelmReleasePayload>): ReleaseSecret {
  const full: HelmReleasePayload = {
    name: payload.name ?? "my-app",
    namespace,
    version: payload.version ?? 1,
    info: { status: payload.info?.status ?? "superseded", last_deployed: payload.info?.last_deployed },
    chart: payload.chart ?? { metadata: { name: "my-app", version: "1.0.0", appVersion: "1.0.0" } },
    config: payload.config ?? {},
    manifest: payload.manifest ?? "",
  };
  return { metadata: { name, namespace }, data: { release: encodeRelease(full) } };
}

test("groupReleases collapses revision secrets into one release with history", () => {
  const secrets: ReleaseSecret[] = [
    secret("sh.helm.release.v1.my-app.v1", "apps", { version: 1, info: { status: "superseded" } }),
    secret("sh.helm.release.v1.my-app.v2", "apps", { version: 2, info: { status: "deployed" } }),
    secret("sh.helm.release.v1.other.v1", "apps", { name: "other", version: 1, info: { status: "deployed" } }),
    secret("not-a-helm-secret", "apps", {}),
  ];
  const releases = groupReleases(secrets);
  expect(releases.map((r) => r.name).sort()).toEqual(["my-app", "other"]);
  const app = releases.find((r) => r.name === "my-app")!;
  expect(app.currentRevision).toBe(2);
  expect(app.status).toBe("deployed");
  expect(app.revisions.map((rv) => rv.revision)).toEqual([2, 1]); // newest first
});

test("groupReleases falls back to highest revision when none marked deployed", () => {
  const secrets: ReleaseSecret[] = [
    secret("sh.helm.release.v1.app.v1", "apps", { version: 1, info: { status: "failed" } }),
    secret("sh.helm.release.v1.app.v2", "apps", { version: 2, info: { status: "failed" } }),
  ];
  const app = groupReleases(secrets).find((r) => r.name === "app")!;
  expect(app.currentRevision).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: FAIL — `groupReleases` / `ReleaseSecret` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/k8s/src/helm.ts`:

```typescript
const RELEASE_SECRET_RE = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/;

export interface ReleaseSecret {
  metadata: { name: string; namespace?: string };
  data?: { release?: string };
}

export interface HelmRevision {
  revision: number;
  status: string;
  chartName: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
  description?: string;
  manifest?: string;
  config?: unknown;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  currentRevision: number;
  status: string;
  chartName: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
  revisions: HelmRevision[];
}

/** Parse a release secret's name into { release, revision }, or null. */
export function parseReleaseSecretName(name: string): { release: string; revision: number } | null {
  const m = name.match(RELEASE_SECRET_RE);
  return m ? { release: m[1]!, revision: Number(m[2]) } : null;
}

/** Collapse `sh.helm.release.v1.*` secrets into releases with newest-first history. */
export function groupReleases(secrets: ReleaseSecret[]): HelmRelease[] {
  const byKey = new Map<string, HelmRevision[]>();
  const ns = new Map<string, string>();
  for (const s of secrets) {
    const parsed = parseReleaseSecretName(s.metadata.name);
    if (!parsed || !s.data?.release) continue;
    const payload = decodeReleaseSecret(s.data.release);
    if (!payload) continue;
    const namespace = s.metadata.namespace ?? payload.namespace;
    const key = `${namespace}/${parsed.release}`;
    ns.set(key, namespace);
    const rev: HelmRevision = {
      revision: parsed.revision,
      status: payload.info.status,
      chartName: payload.chart.metadata.name,
      chartVersion: payload.chart.metadata.version,
      appVersion: payload.chart.metadata.appVersion,
      updated: payload.info.last_deployed,
      description: payload.info.description,
      manifest: payload.manifest,
      config: payload.config,
    };
    const list = byKey.get(key) ?? [];
    list.push(rev);
    byKey.set(key, list);
  }
  const out: HelmRelease[] = [];
  for (const [key, revisions] of byKey) {
    revisions.sort((a, b) => b.revision - a.revision);
    const deployed = revisions.find((r) => r.status === "deployed");
    const current = deployed ?? revisions[0]!;
    out.push({
      name: key.split("/").slice(1).join("/"),
      namespace: ns.get(key)!,
      currentRevision: current.revision,
      status: current.status,
      chartName: current.chartName,
      chartVersion: current.chartVersion,
      appVersion: current.appVersion,
      updated: current.updated,
      revisions,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: PASS (all helm tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/helm.ts packages/k8s/src/helm.test.ts
git commit -m "feat(k8s): group helm release secrets into releases with history"
```

### Task 4: Helm argv builders (install source union, rollback, uninstall)

**Files:**
- Modify: `packages/k8s/src/helm.ts`
- Modify: `packages/k8s/src/helm.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/k8s/src/helm.test.ts`:

```typescript
import {
  buildHelmInstallCommands,
  buildHelmRollbackArgs,
  buildHelmUninstallArgs,
  type HelmChartSource,
} from "./helm";

const opts = { releaseName: "web", namespace: "apps", valuesFile: "/tmp/v.yaml", context: "kind-test" };

test("install commands: repo source does add -> update -> upgrade --install", () => {
  const src: HelmChartSource = { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "v1.14.0" };
  const cmds = buildHelmInstallCommands(src, opts);
  expect(cmds[0]).toEqual(["repo", "add", "jetstack", "https://charts.jetstack.io"]);
  expect(cmds[1]).toEqual(["repo", "update", "jetstack"]);
  expect(cmds[2]).toEqual([
    "upgrade", "--install", "web", "jetstack/cert-manager", "--version", "v1.14.0",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
  ]);
});

test("install commands: oci source skips repo add and installs the ref directly", () => {
  const src: HelmChartSource = { kind: "oci", ref: "oci://registry-1.docker.io/bitnamicharts/postgresql", version: "16.0.0" };
  const cmds = buildHelmInstallCommands(src, opts);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toEqual([
    "upgrade", "--install", "web", "oci://registry-1.docker.io/bitnamicharts/postgresql", "--version", "16.0.0",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
  ]);
});

test("install commands: local source installs from a path, no version flag", () => {
  const cmds = buildHelmInstallCommands({ kind: "local", path: "/charts/web-1.0.0.tgz" }, opts);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toEqual([
    "upgrade", "--install", "web", "/charts/web-1.0.0.tgz",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
  ]);
});

test("install commands: omit context flag when context is null", () => {
  const cmds = buildHelmInstallCommands({ kind: "local", path: "/c.tgz" }, { ...opts, context: null });
  expect(cmds[0]).not.toContain("--kube-context");
});

test("rollback args include revision, namespace, context", () => {
  expect(buildHelmRollbackArgs("web", 3, "apps", "kind-test")).toEqual([
    "rollback", "web", "3", "-n", "apps", "--kube-context", "kind-test",
  ]);
});

test("uninstall args include namespace + context", () => {
  expect(buildHelmUninstallArgs("web", "apps", null)).toEqual(["uninstall", "web", "-n", "apps"]);
  expect(buildHelmUninstallArgs("web", "apps", "kind-test")).toEqual([
    "uninstall", "web", "-n", "apps", "--kube-context", "kind-test",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: FAIL — builders / `HelmChartSource` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/k8s/src/helm.ts`:

```typescript
export type HelmChartSource =
  | { kind: "repo"; repoName: string; repoURL: string; chart: string; version?: string | null }
  | { kind: "oci"; ref: string; version?: string | null }
  | { kind: "local"; path: string };

export interface HelmInstallOpts {
  releaseName: string;
  namespace: string;
  valuesFile: string;
  context: string | null;
}

function ctxArgs(context: string | null): string[] {
  return context ? ["--kube-context", context] : [];
}

/** The chart reference passed to `helm upgrade --install <name> <ref>`. */
function chartRef(src: HelmChartSource): string {
  if (src.kind === "repo") return `${src.repoName}/${src.chart}`;
  if (src.kind === "oci") return src.ref;
  return src.path;
}

/**
 * Ordered helm command argv arrays (each runs as `helm <argv>`). Repo sources
 * emit repo add + repo update before the upgrade; oci/local emit only upgrade.
 */
export function buildHelmInstallCommands(src: HelmChartSource, o: HelmInstallOpts): string[][] {
  const version = src.kind !== "local" && src.version ? ["--version", src.version] : [];
  const upgrade = [
    "upgrade", "--install", o.releaseName, chartRef(src), ...version,
    "-n", o.namespace, "--create-namespace", "-f", o.valuesFile, ...ctxArgs(o.context),
  ];
  if (src.kind === "repo") {
    return [["repo", "add", src.repoName, src.repoURL], ["repo", "update", src.repoName], upgrade];
  }
  return [upgrade];
}

export function buildHelmRollbackArgs(release: string, revision: number, namespace: string, context: string | null): string[] {
  return ["rollback", release, String(revision), "-n", namespace, ...ctxArgs(context)];
}

export function buildHelmUninstallArgs(release: string, namespace: string, context: string | null): string[] {
  return ["uninstall", release, "-n", namespace, ...ctxArgs(context)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test helm`
Expected: PASS (all helm tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/helm.ts packages/k8s/src/helm.test.ts
git commit -m "feat(k8s): helm install/rollback/uninstall argv builders"
```

---

## Phase 2: Server install refactor + routes + Artifact Hub

### Task 5: Refactor install.ts onto the shared builders

**Files:**
- Modify: `apps/server/src/install.ts`
- Modify: `apps/server/src/install.test.ts`

- [ ] **Step 1: Update the test for the new install API**

Replace the `buildHelmArgs` tests in `apps/server/src/install.test.ts` with a test of the new orchestrator entry. Add:

```typescript
import { installHelm, type HelmInstallRequest } from "./install";
import { buildHelmInstallCommands } from "@rigel/k8s/src/helm";

test("install request maps a repo source to the shared builder", () => {
  const req: HelmInstallRequest = {
    source: { kind: "repo", repoName: "sentry", repoURL: "https://sentry-kubernetes.github.io/charts", chart: "sentry", version: "31.7.1" },
    releaseName: "my-sentry",
    namespace: "apps",
    values: "user:\n  create: true\n",
  };
  const cmds = buildHelmInstallCommands(req.source, { releaseName: req.releaseName, namespace: req.namespace, valuesFile: "/tmp/v.yaml", context: "kind-test" });
  expect(cmds[2][0]).toBe("upgrade");
  expect(cmds[2]).toContain("sentry/sentry");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test install`
Expected: FAIL — `HelmInstallRequest` no longer has `source`; `installHelm` signature mismatch.

- [ ] **Step 3: Rewrite install.ts helm portion**

In `apps/server/src/install.ts`, replace the `HelmInstallRequest` interface, `buildHelmArgs`, and the body of `installHelm` so the request carries a `HelmChartSource` and the orchestration runs the shared command list. Keep `applyManifest`/`buildApplyArgs` untouched. New helm section:

```typescript
import { runProcess, runProcessWithStdin, buildKubectlArgs, type RunResult } from "@rigel/k8s/src/run";
import { buildHelmInstallCommands, type HelmChartSource } from "@rigel/k8s/src/helm";
import { unlink, writeFile } from "node:fs/promises";

export interface HelmInstallRequest {
  source: HelmChartSource;
  releaseName: string;
  namespace: string;
  values: string;
}

function runHelm(args: string[]): Promise<RunResult> {
  return runProcess("helm", args);
}

function isAlreadyExists(r: RunResult): boolean {
  return /already exists/i.test(r.stderr) || /already exists/i.test(r.stdout);
}

/**
 * Run the ordered helm install/upgrade commands. Repo `add` tolerates the
 * benign "already exists"; any other non-zero aborts with that result. Values
 * are written to a temp file and removed afterwards. code -1 if helm is missing.
 */
export async function installHelm(context: string | null, req: HelmInstallRequest): Promise<RunResult> {
  let valuesFile: string | null = null;
  try {
    valuesFile = `${process.env.TMPDIR ?? "/tmp"}/rigel-values-${req.releaseName}-${process.pid}-${counter()}.yaml`;
    await writeFile(valuesFile, req.values);
    const cmds = buildHelmInstallCommands(req.source, {
      releaseName: req.releaseName,
      namespace: req.namespace,
      valuesFile,
      context,
    });
    let out = "";
    let err = "";
    for (let i = 0; i < cmds.length; i++) {
      const r = await runHelm(cmds[i]!);
      out += r.stdout;
      err += r.stderr;
      const isRepoAdd = cmds[i]![0] === "repo" && cmds[i]![1] === "add";
      if (r.code !== 0 && !(isRepoAdd && isAlreadyExists(r))) {
        return { code: r.code, stdout: out, stderr: err };
      }
    }
    return { code: 0, stdout: out, stderr: err };
  } catch (e) {
    return { code: -1, stdout: "", stderr: `helm not found: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (valuesFile) await unlink(valuesFile).catch(() => {});
  }
}

let _c = 0;
function counter(): number {
  return (_c = (_c + 1) % 1_000_000);
}
```

(`counter()` replaces `Date.now()` for the temp filename so the module stays free of wall-clock calls; the pid + counter is unique enough for concurrent installs.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rigel/server test install && pnpm --filter @rigel/server typecheck`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Update the catalog `/api/helm` route to the new request shape**

In `apps/server/src/index.ts`, find the existing `POST /api/helm` block (it constructs `installHelm(context, { repoName, repoURL, chart, ... })`). Replace the `installHelm(...)` call with:

```typescript
const result = await installHelm(context, {
  source: {
    kind: "repo",
    repoName: body.repoName,
    repoURL: body.repoURL,
    chart: body.chart,
    version: body.version ?? null,
  },
  releaseName: body.releaseName,
  namespace: body.namespace,
  values: body.values,
});
```

Leave the body parsing/validation for `repoName/repoURL/chart/releaseName/namespace/values` exactly as-is (the catalog still posts those fields).

- [ ] **Step 6: Verify server build**

Run: `pnpm --filter @rigel/server typecheck && pnpm --filter @rigel/server build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/install.ts apps/server/src/install.test.ts apps/server/src/index.ts
git commit -m "refactor(server): install onto shared helm source builders"
```

### Task 6: Artifact Hub search client

**Files:**
- Create: `apps/server/src/artifactHub.ts`
- Create: `apps/server/src/artifactHub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/artifactHub.test.ts`:

```typescript
import { test, expect } from "vitest";
import { parseArtifactHubResults, type ArtifactHubChart } from "./artifactHub";

const SAMPLE = {
  packages: [
    {
      name: "cert-manager",
      version: "1.14.0",
      description: "A Helm chart for cert-manager",
      logo_image_id: "abc",
      repository: { name: "jetstack", url: "https://charts.jetstack.io" },
    },
    {
      name: "postgresql",
      version: "16.0.0",
      description: "PostgreSQL chart",
      repository: { name: "bitnami", url: "oci://registry-1.docker.io/bitnamicharts" },
    },
  ],
};

test("parseArtifactHubResults maps repo vs oci sources", () => {
  const out: ArtifactHubChart[] = parseArtifactHubResults(SAMPLE);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({
    name: "cert-manager",
    version: "1.14.0",
    repoName: "jetstack",
    source: { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "1.14.0" },
  });
  expect(out[1].source).toEqual({
    kind: "oci",
    ref: "oci://registry-1.docker.io/bitnamicharts/postgresql",
    version: "16.0.0",
  });
});

test("parseArtifactHubResults tolerates a missing packages array", () => {
  expect(parseArtifactHubResults({})).toEqual([]);
  expect(parseArtifactHubResults(null)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test artifactHub`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/artifactHub.ts`:

```typescript
// Artifact Hub search client. Artifact Hub is the CNCF registry that aggregates
// Helm charts; it does not host them, so each result resolves to either a repo
// (URL + chart) or an OCI ref that our installer consumes.
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface ArtifactHubChart {
  name: string;
  version: string;
  description: string;
  repoName: string;
  source: HelmChartSource;
}

interface RawPackage {
  name?: string;
  version?: string;
  description?: string;
  repository?: { name?: string; url?: string };
}

/** Map an Artifact Hub search response into installable chart sources. */
export function parseArtifactHubResults(json: unknown): ArtifactHubChart[] {
  const pkgs = (json as { packages?: RawPackage[] } | null)?.packages;
  if (!Array.isArray(pkgs)) return [];
  const out: ArtifactHubChart[] = [];
  for (const p of pkgs) {
    if (!p.name || !p.repository?.url) continue;
    const version = p.version ?? "";
    const url = p.repository.url;
    const repoName = p.repository.name ?? "repo";
    const source: HelmChartSource = url.startsWith("oci://")
      ? { kind: "oci", ref: `${url.replace(/\/$/, "")}/${p.name}`, version: version || null }
      : { kind: "repo", repoName, repoURL: url, chart: p.name, version: version || null };
    out.push({ name: p.name, version, description: p.description ?? "", repoName, source });
  }
  return out;
}

/** Query the Artifact Hub search API for Helm charts (kind=0). */
export async function searchArtifactHub(query: string): Promise<ArtifactHubChart[]> {
  const url = `https://artifacthub.io/api/v1/packages/search?kind=0&limit=20&ts_query_web=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "rigel" } });
    if (!res.ok) return [];
    return parseArtifactHubResults(await res.json().catch(() => null));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/server test artifactHub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/artifactHub.ts apps/server/src/artifactHub.test.ts
git commit -m "feat(server): artifact hub search client"
```

### Task 7: Helm server routes (install/rollback/uninstall/search/show-values)

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add the routes**

In `apps/server/src/index.ts`, near the existing `POST /api/helm` block, add the following route blocks (inside the request `handler`, same `if (url.pathname === ... && req.method === ...)` style). Add imports at the top: `import { buildHelmRollbackArgs, buildHelmUninstallArgs, type HelmChartSource } from "@rigel/k8s/src/helm";`, `import { searchArtifactHub } from "./artifactHub";`, and ensure `runProcess` is imported from `@rigel/k8s/src/run`.

```typescript
// POST /api/helm/install — custom-chart install/upgrade (repo | oci | local).
if (url.pathname === "/api/helm/install" && req.method === "POST") {
  let body: { source?: HelmChartSource; releaseName?: string; namespace?: string; values?: string };
  try { body = (await req.json()) as typeof body; }
  catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!body.source || !body.releaseName || !body.namespace || typeof body.values !== "string") {
    return Response.json({ error: "missing required fields (source, releaseName, namespace, values)" }, { status: 422 });
  }
  const result = await installHelm(context, {
    source: body.source, releaseName: body.releaseName, namespace: body.namespace, values: body.values,
  });
  return Response.json(result);
}

// POST /api/helm/rollback — { release, revision, namespace }
if (url.pathname === "/api/helm/rollback" && req.method === "POST") {
  let body: { release?: string; revision?: number; namespace?: string };
  try { body = (await req.json()) as typeof body; }
  catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!body.release || typeof body.revision !== "number" || !body.namespace) {
    return Response.json({ error: "missing required fields (release, revision, namespace)" }, { status: 422 });
  }
  const result = await runProcess("helm", buildHelmRollbackArgs(body.release, body.revision, body.namespace, context));
  return Response.json(result);
}

// POST /api/helm/uninstall — { release, namespace }
if (url.pathname === "/api/helm/uninstall" && req.method === "POST") {
  let body: { release?: string; namespace?: string };
  try { body = (await req.json()) as typeof body; }
  catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!body.release || !body.namespace) {
    return Response.json({ error: "missing required fields (release, namespace)" }, { status: 422 });
  }
  const result = await runProcess("helm", buildHelmUninstallArgs(body.release, body.namespace, context));
  return Response.json(result);
}

// GET /api/helm/search?q= — Artifact Hub chart search
if (url.pathname === "/api/helm/search" && req.method === "GET") {
  const q = url.searchParams.get("q") ?? "";
  if (q.trim() === "") return Response.json([]);
  return Response.json(await searchArtifactHub(q));
}

// GET /api/helm/show-values?ref=&version= — default chart values for the install form
if (url.pathname === "/api/helm/show-values" && req.method === "GET") {
  const ref = url.searchParams.get("ref");
  const version = url.searchParams.get("version");
  if (!ref) return Response.json({ error: "missing ref" }, { status: 422 });
  const args = ["show", "values", ref, ...(version ? ["--version", version] : [])];
  const result = await runProcess("helm", args);
  return Response.json(result);
}
```

For `show-values` with a repo chart, the client passes `ref` as the repo chart coordinate (e.g. `jetstack/cert-manager`) after a `repo add`; for OCI/local it passes the ref/path directly. The client is responsible for any prior `repo add` via the install path; `show values` on an `oci://` ref or local path works without it.

- [ ] **Step 2: Verify build + typecheck**

Run: `pnpm --filter @rigel/server typecheck && pnpm --filter @rigel/server build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): helm install/rollback/uninstall/search/show-values routes"
```

---

## Phase 3: Electron chart file-open IPC

### Task 8: Add the `openChartFile` IPC bridge

**Files:**
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: the `window.rigel` type declaration (search for `interface Window` / `rigel?:` in `apps/web/src`; add the method there)

- [ ] **Step 1: Add the preload bridge method**

In `apps/desktop/src/preload.ts`, add to the `exposeInMainWorld("rigel", { ... })` object:

```typescript
openChartFile: (): Promise<{ canceled: boolean; path?: string }> =>
  ipcRenderer.invoke("rigel:open-chart-file"),
```

- [ ] **Step 2: Add the main-process handler**

In `apps/desktop/src/main.ts`, add `dialog` to the electron import and register the handler near the other `ipcMain.handle(...)` calls (use the existing main window reference variable name as found in the file):

```typescript
import { app, BrowserWindow, ipcMain, dialog } from "electron";

ipcMain.handle("rigel:open-chart-file", async () => {
  const res = await dialog.showOpenDialog({
    title: "Select a Helm chart (.tgz) or chart folder",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "Helm chart", extensions: ["tgz", "gz"] }, { name: "All files", extensions: ["*"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: res.filePaths[0] };
});
```

- [ ] **Step 3: Extend the `window.rigel` type**

Locate the existing global typing for `window.rigel` (it declares `desktop`, `needsSignup`, `submitSignup`). Add:

```typescript
openChartFile?: () => Promise<{ canceled: boolean; path?: string }>;
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter desktop typecheck && pnpm --filter web typecheck`
Expected: clean (if `desktop` has no typecheck script, run `pnpm --filter desktop build`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload.ts apps/desktop/src/main.ts apps/web/src
git commit -m "feat(desktop): chart file-open dialog IPC"
```

---

## Phase 4: Shared SegmentedTabs component + integrations

### Task 9: Build SegmentedTabs

**Files:**
- Create: `apps/web/src/components/ui/SegmentedTabs.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/ui/SegmentedTabs.tsx`:

```tsx
// Shared segmented-rail tabs: a subtle lighter-gray rounded rail with rounded
// tab buttons; the active tab gets a faint filled pill. Used by the Helm tab,
// the TabModal header, and the catalog scope control.
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedTab {
  id: string;
  label: string;
  badge?: number;
}

interface SegmentedTabsProps {
  tabs: SegmentedTab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function SegmentedTabs({ tabs, active, onChange, className }: SegmentedTabsProps) {
  const rail: CSSProperties = {
    display: "inline-flex",
    gap: 3,
    padding: 3,
    borderRadius: 10,
    background: "rgba(255,255,255,0.04)",
  };
  return (
    <div role="tablist" style={rail} className={className}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className="flex items-center gap-1.5 transition-colors"
            style={{
              padding: "6px 12px",
              borderRadius: 7,
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--fg-primary)" : "var(--fg-tertiary)",
              background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
            }}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span
                className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums")}
                style={{ background: "var(--border-strong)", color: "var(--fg-secondary)" }}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/SegmentedTabs.tsx
git commit -m "feat(web): shared SegmentedTabs component"
```

### Task 10: Adopt SegmentedTabs in TabModal

**Files:**
- Modify: `apps/web/src/components/ui/modal.tsx`

- [ ] **Step 1: Replace the inline tab row**

In `apps/web/src/components/ui/modal.tsx`, import `SegmentedTabs` and replace the `header={ <div className="flex" style={{ gap: 4 }}> ...buttons... </div> }` block in `TabModal` with:

```tsx
header={
  <SegmentedTabs
    tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
    active={current?.id ?? ""}
    onChange={setActive}
  />
}
```

Add `import { SegmentedTabs } from "./SegmentedTabs";` at the top. Leave the rest of `TabModal`, `Modal`, and `ModalFrame` unchanged.

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/modal.tsx
git commit -m "refactor(web): TabModal uses SegmentedTabs"
```

### Task 11: Adopt SegmentedTabs in the catalog scope control

**Files:**
- Modify: `apps/web/src/panels/catalog/CatalogPanel.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Replace the scope control markup**

In `apps/web/src/panels/catalog/CatalogPanel.tsx`, replace the `<div className="catalog-scope-control"> ...two buttons... </div>` with:

```tsx
<SegmentedTabs
  tabs={[
    { id: "all", label: "All" },
    { id: "installed", label: "Installed", badge: installedIDs.size },
  ]}
  active={scope}
  onChange={(id) => setScope(id as typeof scope)}
/>
```

Add `import { SegmentedTabs } from "@/components/ui/SegmentedTabs";`. Confirm `scope` is `"all" | "installed"`; if the type differs, cast accordingly.

- [ ] **Step 2: Remove the dead CSS**

In `apps/web/src/index.css`, delete the `.catalog-scope-control`, `.catalog-scope-btn`, `.catalog-scope-btn:first-child`, `.catalog-scope-btn.active`, and `.catalog-scope-btn:not(.active):hover` rules (the `Scope segmented control` block). Keep `.catalog-scope-count` only if still referenced; the badge now renders inside `SegmentedTabs`, so delete `.catalog-scope-count` and `.catalog-scope-btn.active .catalog-scope-count` too.

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/catalog/CatalogPanel.tsx apps/web/src/index.css
git commit -m "refactor(web): catalog scope control uses SegmentedTabs"
```

---

## Phase 5: Web data layer (release derivation + API hooks)

### Task 12: Release-derivation helper

**Files:**
- Create: `apps/web/src/panels/helm/releases.ts`
- Create: `apps/web/src/panels/helm/releases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/helm/releases.test.ts`:

```typescript
import { test, expect } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { releasesFromSecretsMap } from "./releases";

function encode(payload: unknown): string {
  let bin = "";
  for (const b of gzipSync(strToU8(JSON.stringify(payload)))) bin += String.fromCharCode(b);
  return btoa(btoa(bin));
}
function sec(name: string, namespace: string, version: number, status: string) {
  return {
    metadata: { name, namespace },
    data: { release: encode({ name: name.replace(/^sh\.helm\.release\.v1\.|\.v\d+$/g, ""), namespace, version, info: { status }, chart: { metadata: { name: "c", version: "1.0.0" } } }) },
  };
}

test("releasesFromSecretsMap derives releases from a store secrets map, ignoring non-helm secrets", () => {
  const map = {
    "apps/sh.helm.release.v1.web.v1": sec("sh.helm.release.v1.web.v1", "apps", 1, "superseded"),
    "apps/sh.helm.release.v1.web.v2": sec("sh.helm.release.v1.web.v2", "apps", 2, "deployed"),
    "apps/regular-secret": { metadata: { name: "regular-secret", namespace: "apps" }, data: { foo: btoa("bar") } },
  };
  const releases = releasesFromSecretsMap(map);
  expect(releases).toHaveLength(1);
  expect(releases[0].name).toBe("web");
  expect(releases[0].currentRevision).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test releases`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/helm/releases.ts`:

```typescript
import { groupReleases, type HelmRelease, type ReleaseSecret } from "@rigel/k8s/src/helm";

/** Derive Helm releases from the store's `resources["secrets"]` map. */
export function releasesFromSecretsMap(secrets: Record<string, unknown>): HelmRelease[] {
  return groupReleases(Object.values(secrets) as ReleaseSecret[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test releases`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/helm/releases.ts apps/web/src/panels/helm/releases.test.ts
git commit -m "feat(web): derive helm releases from watched secrets"
```

### Task 13: Web API hooks (`helmApi.ts`)

**Files:**
- Create: `apps/web/src/panels/helm/helmApi.ts`

- [ ] **Step 1: Write the hooks**

Create `apps/web/src/panels/helm/helmApi.ts` (mirror the `postJSON`/`useMutation` and `useQuery` patterns from `panels/catalog/installApi.ts` and `panels/health/HealthPanel.tsx`):

```typescript
import { useMutation, useQuery } from "@tanstack/react-query";
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface RunResult { code: number; stdout: string; stderr: string }
export interface ArtifactHubChart { name: string; version: string; description: string; repoName: string; source: HelmChartSource }

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
  return res.json() as Promise<T>;
}

export interface HelmInstallParams { source: HelmChartSource; releaseName: string; namespace: string; values: string }
export function useHelmInstall() {
  return useMutation<RunResult, Error, HelmInstallParams>({ mutationFn: (p) => postJSON("/api/helm/install", p) });
}

export interface HelmRollbackParams { release: string; revision: number; namespace: string }
export function useHelmRollback() {
  return useMutation<RunResult, Error, HelmRollbackParams>({ mutationFn: (p) => postJSON("/api/helm/rollback", p) });
}

export interface HelmUninstallParams { release: string; namespace: string }
export function useHelmUninstall() {
  return useMutation<RunResult, Error, HelmUninstallParams>({ mutationFn: (p) => postJSON("/api/helm/uninstall", p) });
}

export function useArtifactHubSearch(query: string) {
  return useQuery<ArtifactHubChart[]>({
    queryKey: ["artifact-hub-search", query],
    queryFn: async () => {
      const res = await fetch(`/api/helm/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      return res.json();
    },
    enabled: query.trim().length > 0,
    staleTime: 60_000,
  });
}

export function useHelmShowValues(ref: string | null, version?: string | null) {
  return useQuery<RunResult>({
    queryKey: ["helm-values", ref, version],
    queryFn: async () => {
      const q = new URLSearchParams({ ref: ref! });
      if (version) q.set("version", version);
      const res = await fetch(`/api/helm/show-values?${q.toString()}`);
      if (!res.ok) throw new Error(`show-values ${res.status}`);
      return res.json();
    },
    enabled: !!ref,
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/helm/helmApi.ts
git commit -m "feat(web): helm api hooks"
```

---

## Phase 6: Helm panel UI

### Task 14: HelmConfirmModal (Dialog showing the exact command)

**Files:**
- Create: `apps/web/src/panels/helm/HelmConfirmModal.tsx`

- [ ] **Step 1: Write the component (Dialog, not Sheet)**

Create `apps/web/src/panels/helm/HelmConfirmModal.tsx` using the shared `Modal`:

```tsx
import { Modal } from "@/components/ui/modal";

interface HelmConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The exact helm argv to display, e.g. ["uninstall","web","-n","apps"]. */
  command: string[];
  running: boolean;
  error?: string | null;
  onConfirm: () => void;
}

export function HelmConfirmModal({ open, onOpenChange, title, command, running, error, onConfirm }: HelmConfirmModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <p className="mb-2 text-sm text-muted-foreground">This will run:</p>
      <pre className="mb-4 overflow-x-auto rounded-md bg-black/30 p-3 text-xs">
        {["helm", ...command].join(" ")}
      </pre>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-white/[0.05]" onClick={() => onOpenChange(false)} disabled={running}>
          Cancel
        </button>
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50" onClick={onConfirm} disabled={running}>
          {running ? "Running…" : "Run"}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/helm/HelmConfirmModal.tsx
git commit -m "feat(web): helm confirm dialog"
```

### Task 15: ReleasesView (list + detail + history + actions)

**Files:**
- Create: `apps/web/src/panels/helm/ReleasesView.tsx`

- [ ] **Step 1: Write the view**

Create `apps/web/src/panels/helm/ReleasesView.tsx`. It subscribes to `secrets` (respecting the namespace bar), derives releases, renders a master list and a detail with revision history, a read-only `YamlEditor` for the selected revision's manifest and values, and wires Rollback / Uninstall through `HelmConfirmModal`. Upgrade navigates to the Install view prefilled (handled in Task 17 via a callback prop).

```tsx
import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { buildHelmRollbackArgs, buildHelmUninstallArgs, type HelmRelease, type HelmRevision } from "@rigel/k8s/src/helm";
import { releasesFromSecretsMap } from "./releases";
import { useHelmRollback, useHelmUninstall } from "./helmApi";
import { HelmConfirmModal } from "./HelmConfirmModal";

type Pending =
  | { op: "rollback"; release: HelmRelease; revision: number }
  | { op: "uninstall"; release: HelmRelease }
  | null;

export function ReleasesView({ onUpgrade }: { onUpgrade: (r: HelmRelease) => void }) {
  const resources = useCluster((s) => s.resources);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const rollback = useHelmRollback();
  const uninstall = useHelmUninstall();

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("secrets", ns);
    return () => unsubscribe("secrets", ns);
  }, [namespaceFilter]);

  const releases = useMemo(
    () => releasesFromSecretsMap(resources["secrets"] ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
    [resources],
  );
  const current = releases.find((r) => `${r.namespace}/${r.name}` === selected) ?? null;
  const [rev, setRev] = useState<HelmRevision | null>(null);
  const shownRev = rev ?? current?.revisions[0] ?? null;

  const command = !pending
    ? []
    : pending.op === "rollback"
      ? buildHelmRollbackArgs(pending.release.name, pending.revision, pending.release.namespace, null)
      : buildHelmUninstallArgs(pending.release.name, pending.release.namespace, null);

  function runPending() {
    if (!pending) return;
    setError(null);
    const onErr = (e: Error) => setError(e.message);
    const onOk = (r: { code: number; stderr: string }) => (r.code === 0 ? setPending(null) : setError(r.stderr || `exit ${r.code}`));
    if (pending.op === "rollback") {
      rollback.mutate({ release: pending.release.name, revision: pending.revision, namespace: pending.release.namespace }, { onSuccess: onOk, onError: onErr });
    } else {
      uninstall.mutate({ release: pending.release.name, namespace: pending.release.namespace }, { onSuccess: onOk, onError: onErr });
    }
  }

  return (
    <div className="flex gap-4">
      <ul className="w-64 shrink-0 space-y-1">
        {releases.map((r) => (
          <li key={`${r.namespace}/${r.name}`}>
            <button
              type="button"
              onClick={() => { setSelected(`${r.namespace}/${r.name}`); setRev(null); }}
              className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
              style={{ background: selected === `${r.namespace}/${r.name}` ? "rgba(255,255,255,0.06)" : undefined }}
            >
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-muted-foreground">{r.namespace} · {r.chartName} {r.chartVersion} · {r.status}</div>
            </button>
          </li>
        ))}
        {releases.length === 0 && <li className="px-2.5 py-2 text-sm text-muted-foreground">No Helm releases found.</li>}
      </ul>

      {current && (
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">{current.name}</h2>
              <p className="text-xs text-muted-foreground">rev {current.currentRevision} · {current.status} · updated {current.updated ?? "?"}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-white/[0.05]" onClick={() => onUpgrade(current)}>Upgrade</button>
              <button type="button" className="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10" onClick={() => { setPending({ op: "uninstall", release: current }); setError(null); }}>Uninstall</button>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {current.revisions.map((rv) => (
              <button
                key={rv.revision}
                type="button"
                onClick={() => setRev(rv)}
                className="rounded-md border px-2 py-1 text-xs"
                style={{ borderColor: "var(--border-strong)", background: shownRev?.revision === rv.revision ? "rgba(255,255,255,0.06)" : "transparent" }}
              >
                rev {rv.revision} · {rv.status}
                {rv.revision !== current.currentRevision && (
                  <span className="ml-1 cursor-pointer text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); setPending({ op: "rollback", release: current, revision: rv.revision }); setError(null); }}>↺</span>
                )}
              </button>
            ))}
          </div>

          {shownRev && (
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Values</div>
                <YamlEditor value={toYaml(shownRev.config)} readOnly height="200px" schema={null} />
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manifest</div>
                <YamlEditor value={shownRev.manifest ?? ""} readOnly height="320px" schema={null} />
              </div>
            </div>
          )}
        </div>
      )}

      <HelmConfirmModal
        open={pending != null}
        onOpenChange={(o) => { if (!o) { setPending(null); setError(null); } }}
        title={pending?.op === "uninstall" ? `Uninstall ${pending.release.name}?` : "Roll back release?"}
        command={command}
        running={rollback.isPending || uninstall.isPending}
        error={error}
        onConfirm={runPending}
      />
    </div>
  );
}

/** Render a values object as YAML for read-only display (JSON is valid YAML). */
function toYaml(config: unknown): string {
  if (config == null || (typeof config === "object" && Object.keys(config as object).length === 0)) return "# (no user-set values)";
  return JSON.stringify(config, null, 2);
}
```

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/helm/ReleasesView.tsx
git commit -m "feat(web): helm releases view with history, rollback, uninstall"
```

### Task 16: InstallChartView (four source inputs + values editor)

**Files:**
- Create: `apps/web/src/panels/helm/InstallChartView.tsx`

- [ ] **Step 1: Write the view**

Create `apps/web/src/panels/helm/InstallChartView.tsx`. It offers a source-mode picker (repo / oci / search / local), collects the source, seeds a values editor from `useHelmShowValues`, and submits via `useHelmInstall`, confirming through `HelmConfirmModal`. A `prefill` prop supports the Upgrade path from `ReleasesView`.

```tsx
import { useMemo, useState } from "react";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { buildHelmInstallCommands, type HelmChartSource, type HelmRelease } from "@rigel/k8s/src/helm";
import { useArtifactHubSearch, useHelmInstall, useHelmShowValues } from "./helmApi";
import { HelmConfirmModal } from "./HelmConfirmModal";

type Mode = "repo" | "oci" | "search" | "local";

export function InstallChartView({ prefill }: { prefill: HelmRelease | null }) {
  const [mode, setMode] = useState<Mode>("repo");
  const [releaseName, setReleaseName] = useState(prefill?.name ?? "");
  const [namespace, setNamespace] = useState(prefill?.namespace ?? "default");
  const [repoName, setRepoName] = useState("");
  const [repoURL, setRepoURL] = useState("");
  const [chart, setChart] = useState(prefill?.chartName ?? "");
  const [version, setVersion] = useState("");
  const [ociRef, setOciRef] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [query, setQuery] = useState("");
  const [values, setValues] = useState("# values\n");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useArtifactHubSearch(mode === "search" ? query : "");
  const install = useHelmInstall();

  const source: HelmChartSource | null = useMemo(() => {
    if (mode === "repo") return repoName && repoURL && chart ? { kind: "repo", repoName, repoURL, chart, version: version || null } : null;
    if (mode === "oci") return ociRef ? { kind: "oci", ref: ociRef, version: version || null } : null;
    if (mode === "local") return localPath ? { kind: "local", path: localPath } : null;
    return null; // search prefills repo/oci then switches mode
  }, [mode, repoName, repoURL, chart, version, ociRef, localPath]);

  const showValuesRef = mode === "oci" ? ociRef : mode === "repo" && chart ? chart : null;
  const seeded = useHelmShowValues(showValuesRef, version || null);

  const command = source && releaseName && namespace
    ? buildHelmInstallCommands(source, { releaseName, namespace, valuesFile: "values.yaml", context: null }).at(-1)!
    : [];

  async function pickLocal() {
    if (!window.rigel?.openChartFile) { setError("File picker is only available in the desktop app."); return; }
    const res = await window.rigel.openChartFile();
    if (!res.canceled && res.path) setLocalPath(res.path);
  }

  function submit() {
    if (!source) return;
    setError(null);
    install.mutate(
      { source, releaseName, namespace, values },
      {
        onSuccess: (r) => (r.code === 0 ? setConfirm(false) : setError(r.stderr || `exit ${r.code}`)),
        onError: (e) => setError(e.message),
      },
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex gap-2 text-sm">
        {(["repo", "oci", "search", "local"] as Mode[]).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className="rounded-md px-2.5 py-1.5" style={{ background: mode === m ? "rgba(255,255,255,0.08)" : "transparent" }}>
            {m === "repo" ? "Repo + chart" : m === "oci" ? "OCI ref" : m === "search" ? "Artifact Hub" : "Local file"}
          </button>
        ))}
      </div>

      {mode === "repo" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Repo name" value={repoName} onChange={setRepoName} />
          <Field label="Repo URL" value={repoURL} onChange={setRepoURL} />
          <Field label="Chart" value={chart} onChange={setChart} />
          <Field label="Version (optional)" value={version} onChange={setVersion} />
        </div>
      )}
      {mode === "oci" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="OCI ref (oci://…)" value={ociRef} onChange={setOciRef} />
          <Field label="Version (optional)" value={version} onChange={setVersion} />
        </div>
      )}
      {mode === "local" && (
        <div className="flex items-end gap-2">
          <Field label="Chart path (.tgz or folder)" value={localPath} onChange={setLocalPath} />
          <button type="button" className="rounded-md px-3 py-2 text-sm hover:bg-white/[0.05]" onClick={pickLocal}>Browse…</button>
        </div>
      )}
      {mode === "search" && (
        <div>
          <Field label="Search Artifact Hub" value={query} onChange={setQuery} />
          <ul className="mt-2 space-y-1">
            {(search.data ?? []).map((c, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
                  onClick={() => {
                    if (c.source.kind === "oci") { setMode("oci"); setOciRef(c.source.ref); }
                    else { setMode("repo"); setRepoName(c.source.repoName); setRepoURL(c.source.repoURL); setChart(c.source.chart); }
                    setVersion(c.version);
                    if (!releaseName) setReleaseName(c.name);
                  }}
                >
                  <span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{c.repoName} · {c.version}</span>
                  <div className="text-xs text-muted-foreground">{c.description}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Release name" value={releaseName} onChange={setReleaseName} />
        <Field label="Namespace" value={namespace} onChange={setNamespace} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Values</span>
          {showValuesRef && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => seeded.data?.code === 0 && setValues(seeded.data.stdout)}>
              Load defaults
            </button>
          )}
        </div>
        <YamlEditor value={values} onChange={setValues} height="280px" schema={null} />
      </div>

      <div className="flex justify-end">
        <button type="button" disabled={!source || !releaseName || !namespace} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" onClick={() => { setError(null); setConfirm(true); }}>
          Install
        </button>
      </div>

      <HelmConfirmModal
        open={confirm}
        onOpenChange={(o) => { if (!o) setConfirm(false); }}
        title={`Install ${releaseName || "release"}?`}
        command={command}
        running={install.isPending}
        error={error}
        onConfirm={submit}
      />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <input className="w-full rounded-md border bg-transparent px-2.5 py-1.5" style={{ borderColor: "var(--border-strong)" }} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean. If `window.rigel.openChartFile` types error, ensure Task 8 Step 3 added the optional method to the global typing.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/helm/InstallChartView.tsx
git commit -m "feat(web): custom-chart install view with four sources"
```

### Task 17: HelmPanel shell (SegmentedTabs wiring the two views)

**Files:**
- Create: `apps/web/src/panels/helm/HelmPanel.tsx`

- [ ] **Step 1: Write the panel**

Create `apps/web/src/panels/helm/HelmPanel.tsx`:

```tsx
import { useState } from "react";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import type { HelmRelease } from "@rigel/k8s/src/helm";
import { ReleasesView } from "./ReleasesView";
import { InstallChartView } from "./InstallChartView";

export default function HelmPanel() {
  const [tab, setTab] = useState("releases");
  const [prefill, setPrefill] = useState<HelmRelease | null>(null);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <SegmentedTabs
        tabs={[{ id: "releases", label: "Releases" }, { id: "install", label: "Install chart" }]}
        active={tab}
        onChange={setTab}
      />
      {tab === "releases" ? (
        <ReleasesView onUpgrade={(r) => { setPrefill(r); setTab("install"); }} />
      ) : (
        <InstallChartView prefill={prefill} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/helm/HelmPanel.tsx
git commit -m "feat(web): helm panel shell"
```

### Task 18: Register the Helm tab in nav + router

**Files:**
- Modify: `apps/web/src/shell/NavStrip.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add to PANEL_META and NAV_GROUPS**

In `apps/web/src/shell/NavStrip.tsx`, import a Lucide package icon (e.g. `Package`) in the existing lucide import block, and add to `PANEL_META`:

```tsx
helm: { route: "/helm", title: "Helm", subtitle: "Releases & charts", icon: Package },
```

Add `"helm"` to the appropriate group in `NAV_GROUPS` next to `"catalog"` (find the group containing `catalog` and append `"helm"`).

- [ ] **Step 2: Add the route**

In `apps/web/src/App.tsx`, add a lazy import alongside the other panel imports and a route inside `<Routes>`:

```tsx
const HelmPanel = lazy(() => import("./panels/helm/HelmPanel"));
// ...
<Route path="/helm" element={<HelmPanel />} />
```

(Match the existing import/lazy style in `App.tsx`; if panels are imported eagerly there, follow that instead.)

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/shell/NavStrip.tsx apps/web/src/App.tsx
git commit -m "feat(web): register the Helm tab"
```

---

## Phase 7: Final verification

### Task 19: Full build + test sweep

- [ ] **Step 1: Run everything**

Run:
```bash
pnpm -r typecheck && pnpm -r test && pnpm --filter web build && pnpm --filter @rigel/server build
```
Expected: all green.

- [ ] **Step 2: Manual smoke (desktop dev)**

Run: `pnpm --filter desktop dev`
Verify: the Helm tab appears; Releases lists any `helm` releases in the cluster with history; selecting a revision shows values + manifest; Rollback/Uninstall open a Dialog showing the exact `helm …` command; Install chart switches between the four source modes, "Browse…" opens a native file dialog, "Load defaults" seeds values, and Install opens the confirm Dialog. Confirm the catalog All/Installed control and the TabModal now show the segmented rail.

- [ ] **Step 3: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "chore(helm): final cleanup after verification" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** Releases (Tasks 12, 15), history/values/manifest (Tasks 3, 15), rollback/upgrade/uninstall (Tasks 4, 7, 15, 16), four install sources (Tasks 4, 6, 8, 16), Artifact Hub (Task 6, 16), values seeding (Task 7, 16), shared segmented rail in all three spots (Tasks 9–11), Dialogs not Sheets (Tasks 14–16). Decode + grouping (Tasks 2, 3).
- **Upgrade semantics:** implemented as the Install view prefilled with the release name/namespace/chart (helm `upgrade --install`), so no separate upgrade route is needed; for releases whose source is unknown the user fills the source in the same form.
- **No wall-clock in shared/pure code:** `installHelm` uses a process-local counter for temp filenames instead of `Date.now()`.
- **Type consistency:** `HelmChartSource`, `HelmRelease`, `HelmRevision`, `RunResult` are defined in `packages/k8s/src/helm.ts` and imported everywhere; `helmApi.ts` re-declares `RunResult`/`ArtifactHubChart` for the web boundary intentionally (no server import from web).
