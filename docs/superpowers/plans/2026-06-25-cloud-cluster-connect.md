# Connect to Existing Cloud Clusters (engine + DigitalOcean) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Connect to an existing cluster" path to the cluster rail that connects to a managed cloud cluster (DigitalOcean first; AWS/GCP/Azure are fast-follow descriptors) by driving the provider CLI, plus a generic "Import a kubeconfig" path, with inline install/login/re-login help and a no-op monetization seam.

**Architecture:** Auth is **shell-out (option A)**: Rigel runs the provider CLI (`doctl` for DigitalOcean) for read-only checks, cluster listing, and the `kubeconfig save`/`update-kubeconfig` connect command; the CLI's own `exec` credential block then refreshes the cluster token in perpetuity. Rigel never stores cloud credentials. A node-free shared package `@rigel/cloud-connect` holds per-provider **descriptors** (commands + help text + auth-error patterns) and pure helpers, imported by both `apps/server` (which spawns the commands) and `apps/web` (which renders the wizard + help). A single `canConnect(target)` seam in the server returns allow-all today so Stream 3 can switch on plan gating without a retrofit.

**Tech Stack:** TypeScript, Node (`@hono/node-server`-style `handler(req)` routes in `apps/server`), React + TanStack Query (`apps/web`), Vitest (colocated `*.test.ts`, jsdom opt-in for components via a `// @vitest-environment jsdom` directive), pnpm workspaces.

---

## File structure

**New — `packages/cloud-connect/` (node-free, pure):**
- `package.json`, `tsconfig.json` — workspace package `@rigel/cloud-connect`.
- `src/types.ts` — `CloudProvider`, `CloudCluster`, `ProviderDescriptor`, help types.
- `src/descriptors.ts` — the DigitalOcean descriptor, `DESCRIPTORS`, `descriptorFor`, `listCloudProviders`.
- `src/detectAuthExpiry.ts` — `detectAuthExpiry(provider, stderr)`.
- `src/wizard.ts` — `CheckResult`, `WizardStep`, `nextStepFromCheck`.
- `src/index.ts` — re-exports.
- `src/*.test.ts` — colocated tests.

**New — `apps/server/src/`:**
- `entitlements.ts` — `canConnect(target)` seam (+ test).
- `cloudConnect.ts` — `cloudCheck`, `cloudListClusters`, `cloudConnect`, `cloudHealth`, `importKubeconfig` (injectable runners) (+ test).

**Modify — `apps/server/src/`:**
- `index.ts` — register `POST /api/cloud/check|clusters|connect|health|import`.
- `packages/k8s/src/run.ts` — add optional `{ env }` to `runProcess` (needed so cloud CLIs and the import-merge write to the server's `KUBECONFIG`) (+ test).

**New — `apps/web/src/shell/`:**
- `AddClusterChooser.tsx` — "Create local" vs "Connect existing" chooser (+ test).
- `ConnectClusterModal.tsx` — provider grid + routes to wizard / import panel (+ test).
- `ConnectWizard.tsx` — the per-provider connect state machine (+ test).
- `ImportKubeconfigPanel.tsx` — paste/import a kubeconfig (+ test).
- `ClusterHealthBadge.tsx` — presentational "Needs re-login" badge (+ test).

**Modify — `apps/web/src/`:**
- `lib/api.ts` — cloud action functions + `useClusterHealth`.
- `shell/ClusterRail.tsx` — `+` opens the chooser; render the new modals; show the health badge on the active cloud tile.

---

## Task 1: Scaffold the `@rigel/cloud-connect` package

**Files:**
- Create: `packages/cloud-connect/package.json`
- Create: `packages/cloud-connect/tsconfig.json`
- Create: `packages/cloud-connect/src/index.ts`
- Create: `packages/cloud-connect/src/version.test.ts`
- Modify: `apps/server/package.json` (add dependency)
- Modify: `apps/web/package.json` (add dependency)

- [ ] **Step 1: Create `packages/cloud-connect/package.json`**

```json
{
  "name": "@rigel/cloud-connect",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: Create `packages/cloud-connect/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/cloud-connect/src/index.ts` with a sentinel export**

```ts
/** Package marker; real exports are added in later tasks. */
export const CLOUD_CONNECT_PACKAGE = "@rigel/cloud-connect";
```

- [ ] **Step 4: Write the failing test `packages/cloud-connect/src/version.test.ts`**

```ts
import { test, expect } from "vitest";
import { CLOUD_CONNECT_PACKAGE } from "./index";

test("package marker is exported", () => {
  expect(CLOUD_CONNECT_PACKAGE).toBe("@rigel/cloud-connect");
});
```

- [ ] **Step 5: Add the workspace dependency to `apps/server/package.json`**

In the `"dependencies"` object add `"@rigel/cloud-connect": "workspace:*"` (next to `"@rigel/k8s": "workspace:*"`).

- [ ] **Step 6: Add the workspace dependency to `apps/web/package.json`**

In the `"dependencies"` object add `"@rigel/cloud-connect": "workspace:*"`.

- [ ] **Step 7: Install so pnpm links the new package**

Run: `pnpm install`
Expected: completes; `node_modules/@rigel/cloud-connect` symlink created.

- [ ] **Step 8: Run the test**

Run: `pnpm -C packages/cloud-connect exec vitest run src/version.test.ts`
Expected: 1 passed.

- [ ] **Step 9: Commit**

```bash
git add packages/cloud-connect apps/server/package.json apps/web/package.json pnpm-lock.yaml
git commit -m "feat(cloud-connect): scaffold @rigel/cloud-connect package"
```

---

## Task 2: Provider descriptor types + the DigitalOcean descriptor

**Files:**
- Create: `packages/cloud-connect/src/types.ts`
- Create: `packages/cloud-connect/src/descriptors.ts`
- Create: `packages/cloud-connect/src/descriptors.test.ts`

- [ ] **Step 1: Create `packages/cloud-connect/src/types.ts`**

```ts
export type CloudProvider = "digitalocean" | "aws" | "gcp" | "azure";

/** A cluster as listed from a provider, normalized across providers. */
export interface CloudCluster {
  id: string;
  name: string;
  region: string;
}

export interface InstallHelp {
  macos: string;
  linux: string;
  windows: string;
  docsUrl: string;
}

export interface CommandHelp {
  command: string;
  explanation: string;
  docsUrl?: string;
}

/**
 * Everything Rigel needs to connect to one cloud provider by driving its CLI.
 * Node-free: command builders return argv arrays; the server spawns them.
 */
export interface ProviderDescriptor {
  id: CloudProvider;
  displayName: string;
  /** The CLI binary, e.g. "doctl". */
  binary: string;
  /** Extra binaries kubectl needs at runtime (gcp: gke-gcloud-auth-plugin). */
  extraBinaries: string[];
  installHelp: InstallHelp;
  /** Args that exit 0 iff the binary is present (e.g. ["version"]). */
  versionArgs: string[];
  /** Read-only args that exit 0 iff the user is logged in. */
  authCheckArgs: string[];
  loginHelp: CommandHelp;
  reloginHelp: CommandHelp;
  /** Param keys the user must supply before listing (DigitalOcean: none). */
  requiredParams: string[];
  listClustersArgs: (params: Record<string, string>) => string[];
  parseClusterList: (stdout: string) => CloudCluster[];
  connectArgs: (cluster: CloudCluster, params: Record<string, string>) => string[];
  /** Lowercased-substring matches on kubectl/CLI stderr meaning "re-login". */
  authErrorPatterns: string[];
}
```

- [ ] **Step 2: Create `packages/cloud-connect/src/descriptors.ts`**

```ts
import type { ProviderDescriptor } from "./types";

export const digitalocean: ProviderDescriptor = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  binary: "doctl",
  extraBinaries: [],
  installHelp: {
    macos: "brew install doctl",
    linux: "snap install doctl",
    windows: "scoop install doctl   # or: choco install doctl",
    docsUrl: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
  },
  versionArgs: ["version"],
  authCheckArgs: ["account", "get"],
  loginHelp: {
    command: "doctl auth init",
    explanation:
      "Paste a DigitalOcean Personal Access Token (with the kubernetes:read scope) when prompted.",
    docsUrl: "https://docs.digitalocean.com/reference/api/create-personal-access-token/",
  },
  reloginHelp: {
    command: "doctl auth init",
    explanation:
      "Your DigitalOcean token expired or was revoked. Re-run this and paste a fresh token.",
  },
  requiredParams: [],
  listClustersArgs: () => ["kubernetes", "cluster", "list", "-o", "json"],
  parseClusterList: (stdout) => {
    const arr = JSON.parse(stdout) as { id: string; name: string; region: string }[];
    return arr.map((c) => ({ id: c.id, name: c.name, region: c.region }));
  },
  connectArgs: (cluster) => ["kubernetes", "cluster", "kubeconfig", "save", cluster.id],
  authErrorPatterns: ["401", "unable to authenticate"],
};

/** All providers Rigel can connect to today (DigitalOcean first). */
export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
};

export function descriptorFor(provider: string): ProviderDescriptor | undefined {
  return DESCRIPTORS[provider];
}

export function listCloudProviders(): ProviderDescriptor[] {
  return Object.values(DESCRIPTORS);
}
```

- [ ] **Step 3: Write the failing test `packages/cloud-connect/src/descriptors.test.ts`**

```ts
import { test, expect } from "vitest";
import { descriptorFor, listCloudProviders } from "./descriptors";

test("descriptorFor returns the DigitalOcean descriptor", () => {
  const d = descriptorFor("digitalocean");
  expect(d?.binary).toBe("doctl");
  expect(d?.requiredParams).toEqual([]);
});

test("descriptorFor returns undefined for unknown/non-cloud providers", () => {
  expect(descriptorFor("local")).toBeUndefined();
  expect(descriptorFor("aws")).toBeUndefined(); // fast-follow, not built yet
});

test("DigitalOcean builds the expected list and connect argv", () => {
  const d = descriptorFor("digitalocean")!;
  expect(d.listClustersArgs({})).toEqual(["kubernetes", "cluster", "list", "-o", "json"]);
  expect(d.connectArgs({ id: "abc-123", name: "prod", region: "nyc1" }, {})).toEqual([
    "kubernetes", "cluster", "kubeconfig", "save", "abc-123",
  ]);
});

test("DigitalOcean parses doctl JSON cluster output", () => {
  const d = descriptorFor("digitalocean")!;
  const stdout = JSON.stringify([
    { id: "abc-123", name: "prod", region: "nyc1", version: "1.30" },
    { id: "def-456", name: "stage", region: "sfo3", version: "1.30" },
  ]);
  expect(d.parseClusterList(stdout)).toEqual([
    { id: "abc-123", name: "prod", region: "nyc1" },
    { id: "def-456", name: "stage", region: "sfo3" },
  ]);
});

test("listCloudProviders returns exactly the built providers", () => {
  expect(listCloudProviders().map((d) => d.id)).toEqual(["digitalocean"]);
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/cloud-connect exec vitest run src/descriptors.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Re-export from `index.ts`**

Replace `packages/cloud-connect/src/index.ts` with:

```ts
export * from "./types";
export * from "./descriptors";
```

- [ ] **Step 6: Delete the now-redundant sentinel test**

Run: `git rm packages/cloud-connect/src/version.test.ts`
(The marker export is gone; `descriptors.test.ts` covers the package.)

- [ ] **Step 7: Run the package tests + typecheck**

Run: `pnpm -C packages/cloud-connect test && pnpm -C packages/cloud-connect typecheck`
Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cloud-connect
git commit -m "feat(cloud-connect): descriptor types + DigitalOcean descriptor"
```

---

## Task 3: `detectAuthExpiry` matcher

**Files:**
- Create: `packages/cloud-connect/src/detectAuthExpiry.ts`
- Create: `packages/cloud-connect/src/detectAuthExpiry.test.ts`
- Modify: `packages/cloud-connect/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/cloud-connect/src/detectAuthExpiry.test.ts`**

```ts
import { test, expect } from "vitest";
import { detectAuthExpiry } from "./detectAuthExpiry";

test("matches a DigitalOcean auth-expiry stderr (case-insensitive)", () => {
  expect(detectAuthExpiry("digitalocean", "Error: Unable to authenticate you")).toBe(true);
  expect(detectAuthExpiry("digitalocean", "the server responded with status 401")).toBe(true);
});

test("does not match an unrelated error", () => {
  expect(detectAuthExpiry("digitalocean", "connection refused")).toBe(false);
});

test("returns false for an unknown provider", () => {
  expect(detectAuthExpiry("aws", "401")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C packages/cloud-connect exec vitest run src/detectAuthExpiry.test.ts`
Expected: FAIL ("Cannot find module './detectAuthExpiry'").

- [ ] **Step 3: Create `packages/cloud-connect/src/detectAuthExpiry.ts`**

```ts
import { descriptorFor } from "./descriptors";

/** True when the CLI/kubectl stderr indicates the user must re-login for `provider`. */
export function detectAuthExpiry(provider: string, stderr: string): boolean {
  const d = descriptorFor(provider);
  if (!d) return false;
  const s = stderr.toLowerCase();
  return d.authErrorPatterns.some((p) => s.includes(p.toLowerCase()));
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/cloud-connect exec vitest run src/detectAuthExpiry.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Add to `index.ts`**

Append to `packages/cloud-connect/src/index.ts`:

```ts
export * from "./detectAuthExpiry";
```

- [ ] **Step 6: Commit**

```bash
git add packages/cloud-connect
git commit -m "feat(cloud-connect): auth-expiry stderr matcher"
```

---

## Task 4: `nextStepFromCheck` wizard step decision

**Files:**
- Create: `packages/cloud-connect/src/wizard.ts`
- Create: `packages/cloud-connect/src/wizard.test.ts`
- Modify: `packages/cloud-connect/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/cloud-connect/src/wizard.test.ts`**

```ts
import { test, expect } from "vitest";
import { nextStepFromCheck } from "./wizard";

test("missing CLI takes priority", () => {
  expect(nextStepFromCheck({ cliInstalled: false, extraBinariesInstalled: false, authenticated: false }))
    .toBe("needs-cli");
});

test("CLI present but extra binary missing", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: false, authenticated: false }))
    .toBe("needs-extra");
});

test("CLI + extras present but not logged in", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: true, authenticated: false }))
    .toBe("needs-login");
});

test("everything ready", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }))
    .toBe("ready");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C packages/cloud-connect exec vitest run src/wizard.test.ts`
Expected: FAIL ("Cannot find module './wizard'").

- [ ] **Step 3: Create `packages/cloud-connect/src/wizard.ts`**

```ts
export interface CheckResult {
  cliInstalled: boolean;
  extraBinariesInstalled: boolean;
  authenticated: boolean;
}

export type WizardStep = "needs-cli" | "needs-extra" | "needs-login" | "ready";

/** Decide the next wizard step from a provider check result. */
export function nextStepFromCheck(c: CheckResult): WizardStep {
  if (!c.cliInstalled) return "needs-cli";
  if (!c.extraBinariesInstalled) return "needs-extra";
  if (!c.authenticated) return "needs-login";
  return "ready";
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/cloud-connect exec vitest run src/wizard.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add to `index.ts`**

Append to `packages/cloud-connect/src/index.ts`:

```ts
export * from "./wizard";
```

- [ ] **Step 6: Commit**

```bash
git add packages/cloud-connect
git commit -m "feat(cloud-connect): wizard step decision helper"
```

---

## Task 5: Add optional `env` to `runProcess`

The cloud connect command and the import-merge must run with `KUBECONFIG` pointed at the server's config so the context lands where `/api/contexts` reads it. `runProcess` currently spawns without a custom env. Extend it (backward-compatible: omitting `opts` inherits `process.env`).

**Files:**
- Modify: `packages/k8s/src/run.ts:48-50`
- Create: `packages/k8s/src/run.test.ts`

- [ ] **Step 1: Write the failing test `packages/k8s/src/run.test.ts`**

```ts
import { test, expect } from "vitest";
import { runProcess } from "./run";

test("runProcess inherits process.env when no opts given", async () => {
  process.env.RIGEL_RUN_TEST = "inherited";
  const r = await runProcess(process.execPath, ["-e", "process.stdout.write(process.env.RIGEL_RUN_TEST ?? '')"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("inherited");
  delete process.env.RIGEL_RUN_TEST;
});

test("runProcess uses a provided env", async () => {
  const r = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write(process.env.RIGEL_RUN_TEST ?? 'MISSING')"],
    { env: { ...process.env, RIGEL_RUN_TEST: "provided" } },
  );
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("provided");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C packages/k8s exec vitest run src/run.test.ts`
Expected: FAIL on the second test (TS error: `runProcess` takes 2 args / `Expected 2 arguments, but got 3`).

- [ ] **Step 3: Edit `runProcess` in `packages/k8s/src/run.ts`**

Replace the existing `runProcess` (lines ~48-50):

```ts
/** Run a binary to completion via node:child_process spawn (argv array — no shell). */
export function runProcess(bin: string, args: string[]): Promise<RunResult> {
  return collectProcess(spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }));
}
```

with:

```ts
/**
 * Run a binary to completion via node:child_process spawn (argv array — no shell).
 * `opts.env` overrides the child's environment (e.g. to set KUBECONFIG); when
 * omitted the child inherits the parent process env.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return collectProcess(spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: opts?.env }));
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/k8s exec vitest run src/run.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Typecheck the whole repo (no existing caller breaks)**

Run: `pnpm -r typecheck`
Expected: no errors (the new param is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/run.ts packages/k8s/src/run.test.ts
git commit -m "feat(k8s): runProcess accepts an optional env override"
```

---

## Task 6: The `canConnect` monetization seam

**Files:**
- Create: `apps/server/src/entitlements.ts`
- Create: `apps/server/src/entitlements.test.ts`

- [ ] **Step 1: Write the failing test `apps/server/src/entitlements.test.ts`**

```ts
import { test, expect } from "vitest";
import { canConnect } from "./entitlements";

test("v1 allows connecting to every target (no enforcement yet)", () => {
  for (const t of ["digitalocean", "aws", "gcp", "azure", "import"] as const) {
    expect(canConnect(t)).toEqual({ allowed: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/server exec vitest run src/entitlements.test.ts`
Expected: FAIL ("Cannot find module './entitlements'").

- [ ] **Step 3: Create `apps/server/src/entitlements.ts`**

```ts
import type { CloudProvider } from "@rigel/cloud-connect/src/index";

export type ConnectTarget = CloudProvider | "import";

export interface Entitlement {
  allowed: boolean;
  reason?: string;
}

/**
 * Monetization seam (Stream 3 / HELM-16 will consult the user's plan here, e.g.
 * keep `import` free and gate the cloud providers). v1 allows everything.
 */
export function canConnect(_target: ConnectTarget): Entitlement {
  return { allowed: true };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/server exec vitest run src/entitlements.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/entitlements.ts apps/server/src/entitlements.test.ts
git commit -m "feat(server): canConnect entitlement seam (allow-all, not enforced)"
```

---

## Task 7: Server cloud-connect logic (`cloudConnect.ts`)

All functions take an injectable runner so they're tested without spawning. The runner type matches the extended `runProcess` (`(bin, args, opts?) => Promise<RunResult>`).

**Files:**
- Create: `apps/server/src/cloudConnect.ts`
- Create: `apps/server/src/cloudConnect.test.ts`

- [ ] **Step 1: Create `apps/server/src/cloudConnect.ts`**

```ts
import { runProcess, type RunResult } from "@rigel/k8s/src/run";
import { backupKubeconfig } from "./kubeconfigBackup";
import { descriptorFor, detectAuthExpiry, type CloudCluster } from "@rigel/cloud-connect/src/index";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

export type Run = (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
type BackupFn = (kubeconfigPath: string) => Promise<string | null>;

export interface CloudCheck {
  cliInstalled: boolean;
  extraBinariesInstalled: boolean;
  authenticated: boolean;
}

/** Is the provider CLI installed (+ any extra binaries) and is the user logged in? */
export async function cloudCheck(provider: string, run: Run = runProcess): Promise<CloudCheck> {
  const d = descriptorFor(provider);
  if (!d) return { cliInstalled: false, extraBinariesInstalled: false, authenticated: false };
  const cliInstalled = (await run(d.binary, d.versionArgs)).code === 0;
  let extraBinariesInstalled = true;
  for (const b of d.extraBinaries) {
    if ((await run(b, ["--version"])).code !== 0) extraBinariesInstalled = false;
  }
  const authenticated = cliInstalled && (await run(d.binary, d.authCheckArgs)).code === 0;
  return { cliInstalled, extraBinariesInstalled, authenticated };
}

export interface ListResult {
  clusters?: CloudCluster[];
  error?: string;
  stderr?: string;
}

/** List the user's clusters for `provider` via its CLI. */
export async function cloudListClusters(
  provider: string,
  params: Record<string, string>,
  run: Run = runProcess,
): Promise<ListResult> {
  const d = descriptorFor(provider);
  if (!d) return { error: "unknown provider" };
  const res = await run(d.binary, d.listClustersArgs(params));
  if (res.code !== 0) return { error: "failed to list clusters", stderr: res.stderr };
  try {
    return { clusters: d.parseClusterList(res.stdout) };
  } catch {
    return { error: "could not parse cluster list", stderr: res.stdout };
  }
}

export interface ConnectDeps {
  kubeconfigPath: string;
  run?: Run;
  backup?: BackupFn;
}
export interface ConnectResult {
  context?: string;
  backupPath?: string | null;
  error?: string;
  stderr?: string;
}

/** Run the provider's connect command, writing the context into the server's KUBECONFIG. */
export async function cloudConnect(
  provider: string,
  cluster: CloudCluster,
  params: Record<string, string>,
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const d = descriptorFor(provider);
  if (!d) return { error: "unknown provider" };
  const run = deps.run ?? runProcess;
  const backup = deps.backup ?? ((p) => backupKubeconfig(p));
  const env = { ...process.env, KUBECONFIG: deps.kubeconfigPath };
  const backupPath = await backup(deps.kubeconfigPath);
  const res = await run(d.binary, d.connectArgs(cluster, params), { env });
  if (res.code !== 0) return { error: "connect failed", stderr: res.stderr, backupPath };
  const cur = await run("kubectl", ["config", "current-context"], { env });
  return { context: cur.code === 0 ? cur.stdout.trim() : undefined, backupPath };
}

export interface HealthResult {
  ok: boolean;
  authExpired: boolean;
  stderr?: string;
}

/** Probe a connected context; flag re-login when the failure matches the provider's patterns. */
export async function cloudHealth(provider: string, context: string, run: Run = runProcess): Promise<HealthResult> {
  const res = await run("kubectl", ["--context", context, "get", "--raw=/version"]);
  if (res.code === 0) return { ok: true, authExpired: false };
  return { ok: false, authExpired: detectAuthExpiry(provider, res.stderr), stderr: res.stderr };
}

export interface ImportDeps {
  kubeconfigPath: string;
  run?: Run;
  write?: (p: string, data: string) => Promise<void>;
  rm?: (p: string) => Promise<void>;
  backup?: BackupFn;
  tmpPath?: string;
}
export interface ImportResult {
  ok: boolean;
  backupPath?: string | null;
  added?: string[];
  error?: string;
}

/** Merge a pasted kubeconfig into the server's config (existing entries win). */
export async function importKubeconfig(kubeconfig: string, deps: ImportDeps): Promise<ImportResult> {
  const run = deps.run ?? runProcess;
  const write = deps.write ?? ((p, data) => writeFile(p, data, "utf8"));
  const rm = deps.rm ?? ((p) => unlink(p).catch(() => {}));
  const backup = deps.backup ?? ((p) => backupKubeconfig(p));
  const tmp = deps.tmpPath ?? join(tmpdir(), `rigel-import-${Date.now()}.yaml`);
  try {
    await write(tmp, kubeconfig);
    const incoming = await run("kubectl", ["config", "view", "-o", "json"], {
      env: { ...process.env, KUBECONFIG: tmp },
    });
    if (incoming.code !== 0) return { ok: false, error: incoming.stderr || "invalid kubeconfig" };
    let added: string[];
    try {
      added = ((JSON.parse(incoming.stdout).contexts ?? []) as { name: string }[]).map((c) => c.name);
    } catch {
      return { ok: false, error: "invalid kubeconfig" };
    }
    const merged = await run("kubectl", ["config", "view", "--flatten", "-o", "yaml"], {
      env: { ...process.env, KUBECONFIG: `${deps.kubeconfigPath}${delimiter}${tmp}` },
    });
    if (merged.code !== 0) return { ok: false, error: merged.stderr || "merge failed" };
    const backupPath = await backup(deps.kubeconfigPath);
    await write(deps.kubeconfigPath, merged.stdout);
    return { ok: true, backupPath, added };
  } finally {
    await rm(tmp);
  }
}
```

- [ ] **Step 2: Write the failing test `apps/server/src/cloudConnect.test.ts`**

```ts
import { test, expect, vi } from "vitest";
import {
  cloudCheck, cloudListClusters, cloudConnect, cloudHealth, importKubeconfig,
  type Run,
} from "./cloudConnect";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1) => ({ code, stdout: "", stderr });

test("cloudCheck reports installed + authenticated when both probes exit 0", async () => {
  const run: Run = async () => ok();
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: true, extraBinariesInstalled: true, authenticated: true,
  });
});

test("cloudCheck reports not-authenticated when the auth probe fails", async () => {
  const run: Run = async (_bin, args) => (args[0] === "account" ? fail("not logged in") : ok());
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: true, extraBinariesInstalled: true, authenticated: false,
  });
});

test("cloudCheck reports CLI missing when the version probe fails", async () => {
  const run: Run = async () => fail("command not found", -1);
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: false, extraBinariesInstalled: true, authenticated: false,
  });
});

test("cloudListClusters parses the CLI JSON into clusters", async () => {
  const run: Run = async () => ok(JSON.stringify([{ id: "a", name: "prod", region: "nyc1" }]));
  expect(await cloudListClusters("digitalocean", {}, run)).toEqual({
    clusters: [{ id: "a", name: "prod", region: "nyc1" }],
  });
});

test("cloudListClusters returns stderr on a failed list", async () => {
  const run: Run = async () => fail("boom");
  expect(await cloudListClusters("digitalocean", {}, run)).toEqual({
    error: "failed to list clusters", stderr: "boom",
  });
});

test("cloudConnect runs connect then returns the new current-context + backup", async () => {
  const calls: string[][] = [];
  const run: Run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "config" && args[1] === "current-context") return ok("do-nyc1-prod\n");
    return ok();
  };
  const backup = vi.fn(async () => "/home/u/.kube/config.rigel-backup-x");
  const res = await cloudConnect(
    "digitalocean",
    { id: "abc", name: "prod", region: "nyc1" },
    {},
    { kubeconfigPath: "/home/u/.kube/config", run, backup },
  );
  expect(res).toEqual({ context: "do-nyc1-prod", backupPath: "/home/u/.kube/config.rigel-backup-x" });
  expect(backup).toHaveBeenCalledWith("/home/u/.kube/config");
  expect(calls[0]).toEqual(["doctl", "kubernetes", "cluster", "kubeconfig", "save", "abc"]);
});

test("cloudConnect surfaces stderr when the connect command fails", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "kubernetes" ? fail("403 forbidden") : ok();
  const res = await cloudConnect(
    "digitalocean", { id: "abc", name: "p", region: "r" }, {},
    { kubeconfigPath: "/k", run, backup: async () => null },
  );
  expect(res.error).toBe("connect failed");
  expect(res.stderr).toBe("403 forbidden");
});

test("cloudHealth flags authExpired on a matching stderr", async () => {
  const run: Run = async () => fail("Unable to authenticate you");
  expect(await cloudHealth("digitalocean", "do-nyc1-prod", run)).toEqual({
    ok: false, authExpired: true, stderr: "Unable to authenticate you",
  });
});

test("cloudHealth reports ok when the probe exits 0", async () => {
  const run: Run = async () => ok("{}");
  expect(await cloudHealth("digitalocean", "do-nyc1-prod", run)).toEqual({ ok: true, authExpired: false });
});

test("importKubeconfig merges and returns the incoming context names", async () => {
  const writes: Record<string, string> = {};
  const run: Run = async (_bin, args, opts) => {
    if (args.includes("--flatten")) return ok("merged-yaml");
    // listing the incoming file's contexts
    if ((opts?.env?.KUBECONFIG ?? "").includes("rigel-import")) {
      return ok(JSON.stringify({ contexts: [{ name: "do-nyc1-new" }] }));
    }
    return ok();
  };
  const res = await importKubeconfig("apiVersion: v1\nkind: Config", {
    kubeconfigPath: "/home/u/.kube/config",
    run,
    write: async (p, data) => { writes[p] = data; },
    rm: async () => {},
    backup: async () => "/home/u/.kube/config.rigel-backup-x",
    tmpPath: "/tmp/rigel-import-1.yaml",
  });
  expect(res).toEqual({ ok: true, backupPath: "/home/u/.kube/config.rigel-backup-x", added: ["do-nyc1-new"] });
  expect(writes["/home/u/.kube/config"]).toBe("merged-yaml");
});

test("importKubeconfig rejects an invalid kubeconfig", async () => {
  const run: Run = async () => fail("error loading config");
  const res = await importKubeconfig("garbage", {
    kubeconfigPath: "/k", run, write: async () => {}, rm: async () => {}, backup: async () => null,
    tmpPath: "/tmp/rigel-import-2.yaml",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toBe("error loading config");
});
```

- [ ] **Step 3: Run the tests**

Run: `pnpm -C apps/server exec vitest run src/cloudConnect.test.ts`
Expected: 11 passed.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/cloudConnect.ts apps/server/src/cloudConnect.test.ts
git commit -m "feat(server): cloud connect logic (check/list/connect/health/import)"
```

---

## Task 8: Register the cloud routes in `index.ts`

**Files:**
- Modify: `apps/server/src/index.ts` (imports near lines 38-40; new route blocks alongside the `/api/cluster/*` handlers ~105-131)

- [ ] **Step 1: Add imports near the other server-module imports (top of `index.ts`)**

```ts
import {
  cloudCheck, cloudListClusters, cloudConnect, cloudHealth, importKubeconfig,
} from "./cloudConnect";
import { canConnect, type ConnectTarget } from "./entitlements";
import type { CloudCluster } from "@rigel/cloud-connect/src/index";
```

- [ ] **Step 2: Add the five route blocks (place them right after the `POST /api/cluster/delete` block, ~line 131)**

```ts
    // POST /api/cloud/check { provider } — is the provider CLI installed + logged in?
    // Read-only; always HTTP 200 with a status payload.
    if (url.pathname === "/api/cloud/check" && req.method === "POST") {
      let body: { provider?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string") {
        return Response.json({ error: "provider required" }, { status: 422 });
      }
      return Response.json(await cloudCheck(body.provider));
    }

    // POST /api/cloud/clusters { provider, params } — list the user's clusters. 200.
    if (url.pathname === "/api/cloud/clusters" && req.method === "POST") {
      let body: { provider?: string; params?: Record<string, string> };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string") {
        return Response.json({ error: "provider required" }, { status: 422 });
      }
      return Response.json(await cloudListClusters(body.provider, body.params ?? {}));
    }

    // POST /api/cloud/connect { provider, cluster, params } — write the kubeconfig
    // context (backs up first). The canConnect seam gates this (allow-all today).
    if (url.pathname === "/api/cloud/connect" && req.method === "POST") {
      let body: { provider?: string; cluster?: CloudCluster; params?: Record<string, string> };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || !body.cluster?.id) {
        return Response.json({ error: "provider and cluster required" }, { status: 422 });
      }
      const gate = canConnect(body.provider as ConnectTarget);
      if (!gate.allowed) {
        return Response.json({ error: gate.reason ?? "upgrade required", gated: true }, { status: 402 });
      }
      return Response.json(
        await cloudConnect(body.provider, body.cluster, body.params ?? {}, { kubeconfigPath: KUBECONFIG }),
      );
    }

    // POST /api/cloud/health { provider, context } — probe a connected context. 200.
    if (url.pathname === "/api/cloud/health" && req.method === "POST") {
      let body: { provider?: string; context?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || typeof body.context !== "string") {
        return Response.json({ error: "provider and context required" }, { status: 422 });
      }
      return Response.json(await cloudHealth(body.provider, body.context));
    }

    // POST /api/cloud/import { kubeconfig } — merge a pasted kubeconfig (backs up first).
    if (url.pathname === "/api/cloud/import" && req.method === "POST") {
      let body: { kubeconfig?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.kubeconfig !== "string" || body.kubeconfig.trim() === "") {
        return Response.json({ error: "kubeconfig required" }, { status: 422 });
      }
      const gate = canConnect("import");
      if (!gate.allowed) {
        return Response.json({ error: gate.reason ?? "upgrade required", gated: true }, { status: 402 });
      }
      return Response.json(await importKubeconfig(body.kubeconfig, { kubeconfigPath: KUBECONFIG }));
    }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C apps/server typecheck`
Expected: no errors. (Confirms `KUBECONFIG` is in scope here — it's the module-level constant at `index.ts:54` — and the imports resolve.)

- [ ] **Step 4: Run the full server test suite (nothing regressed)**

Run: `pnpm -C apps/server test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): register /api/cloud/{check,clusters,connect,health,import} routes"
```

---

## Task 9: Web API functions + `useClusterHealth`

**Files:**
- Modify: `apps/web/src/lib/api.ts` (append near the cluster section, after `useDeleteCluster` ~line 1009)

- [ ] **Step 1: Append the cloud API surface to `apps/web/src/lib/api.ts`**

```ts
// ---- Cloud connect ----

export type CloudProvider = "digitalocean" | "aws" | "gcp" | "azure";
export interface CloudCluster { id: string; name: string; region: string }
export interface CloudCheckResult {
  cliInstalled: boolean;
  extraBinariesInstalled: boolean;
  authenticated: boolean;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `request failed: ${res.status}`);
  return data as T;
}

export const cloudCheck = (provider: CloudProvider) =>
  postJson<CloudCheckResult>("/api/cloud/check", { provider });

export const cloudListClusters = (provider: CloudProvider) =>
  postJson<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>(
    "/api/cloud/clusters", { provider, params: {} },
  );

export async function cloudConnect(provider: CloudProvider, cluster: CloudCluster) {
  const r = await postJson<{ context?: string; backupPath?: string | null; error?: string; stderr?: string }>(
    "/api/cloud/connect", { provider, cluster, params: {} },
  );
  if (r.error) throw new Error(r.stderr || r.error);
  return r;
}

export async function importKubeconfig(kubeconfig: string) {
  const r = await postJson<{ ok: boolean; backupPath?: string | null; added?: string[]; error?: string }>(
    "/api/cloud/import", { kubeconfig },
  );
  if (!r.ok) throw new Error(r.error ?? "import failed");
  return r;
}

export interface ClusterHealth { ok: boolean; authExpired: boolean }

/** Poll a connected cloud context's health to drive the "Needs re-login" badge. */
export function useClusterHealth(context: string | null, provider: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cluster-health", context] as const,
    queryFn: () => postJson<ClusterHealth>("/api/cloud/health", { provider, context }),
    enabled: enabled && !!context,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Typecheck the web app**

Run: `pnpm -C apps/web typecheck`
Expected: no errors. (`useQuery` is already imported at the top of `api.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): cloud connect API functions + useClusterHealth"
```

---

## Task 10: `ImportKubeconfigPanel` component

**Files:**
- Create: `apps/web/src/shell/ImportKubeconfigPanel.tsx`
- Create: `apps/web/src/shell/ImportKubeconfigPanel.test.tsx`

- [ ] **Step 1: Write the failing test `apps/web/src/shell/ImportKubeconfigPanel.test.tsx`**

```tsx
// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";

test("Import is disabled until text is entered, then submits and reports added contexts", async () => {
  const onImport = vi.fn().mockResolvedValue({ ok: true, added: ["do-nyc1-new"], backupPath: null });
  const onDone = vi.fn();
  render(<ImportKubeconfigPanel onImport={onImport} onDone={onDone} />);

  const btn = screen.getByRole("button", { name: /import/i });
  expect(btn).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/kubeconfig/i), { target: { value: "apiVersion: v1" } });
  expect(btn).toBeEnabled();

  fireEvent.click(btn);
  await waitFor(() => expect(onImport).toHaveBeenCalledWith("apiVersion: v1"));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test("shows the error when import throws", async () => {
  const onImport = vi.fn().mockRejectedValue(new Error("invalid kubeconfig"));
  render(<ImportKubeconfigPanel onImport={onImport} onDone={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/kubeconfig/i), { target: { value: "garbage" } });
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  await waitFor(() => expect(screen.getByText(/invalid kubeconfig/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web exec vitest run src/shell/ImportKubeconfigPanel.test.tsx`
Expected: FAIL ("Cannot find module './ImportKubeconfigPanel'").

- [ ] **Step 3: Create `apps/web/src/shell/ImportKubeconfigPanel.tsx`**

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { importKubeconfig as defaultImport } from "@/lib/api";
import { toast } from "sonner";

export function ImportKubeconfigPanel({
  onImport = defaultImport,
  onDone,
}: {
  onImport?: (kubeconfig: string) => Promise<{ ok: boolean; added?: string[]; backupPath?: string | null }>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await onImport(text.trim());
      qc.invalidateQueries({ queryKey: ["contexts"] });
      toast.success(
        `Imported ${r.added?.length ?? 0} context${r.added?.length === 1 ? "" : "s"}`,
        { description: r.backupPath ? `Kubeconfig backed up to ${r.backupPath}` : undefined },
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label htmlFor="kubeconfig-text" style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
        Paste a kubeconfig
      </label>
      <textarea
        id="kubeconfig-text"
        aria-label="kubeconfig"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={10}
        style={{
          fontFamily: "var(--font-mono, monospace)", fontSize: 12, padding: 8, borderRadius: 8,
          background: "var(--surface-primary)", color: "var(--fg-primary)",
          border: "1px solid var(--border-strong)", resize: "vertical",
        }}
      />
      {error ? <div style={{ color: "var(--danger, #e5484d)", fontSize: 12 }}>{error}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button disabled={!text.trim() || busy} onClick={submit}>
          {busy ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/web exec vitest run src/shell/ImportKubeconfigPanel.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/ImportKubeconfigPanel.tsx apps/web/src/shell/ImportKubeconfigPanel.test.tsx
git commit -m "feat(web): import-a-kubeconfig panel"
```

---

## Task 11: `ConnectWizard` component (DigitalOcean path)

The wizard takes injectable `actions` so tests run without network. Help text comes from the descriptor.

**Files:**
- Create: `apps/web/src/shell/ConnectWizard.tsx`
- Create: `apps/web/src/shell/ConnectWizard.test.tsx`

- [ ] **Step 1: Write the failing test `apps/web/src/shell/ConnectWizard.test.tsx`**

```tsx
// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectWizard } from "./ConnectWizard";
import { descriptorFor } from "@rigel/cloud-connect/src/index";

const doDesc = descriptorFor("digitalocean")!;
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("shows install help when the CLI is missing", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/brew install doctl/i)).toBeInTheDocument());
});

test("shows login help when not authenticated", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/doctl auth init/i)).toBeInTheDocument());
});

test("lists clusters and connects the chosen one", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "abc", name: "prod", region: "nyc1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "do-nyc1-prod", backupPath: null }),
  };
  const onConnected = vi.fn();
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={onConnected} />);

  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("digitalocean", { id: "abc", name: "prod", region: "nyc1" }));
  await waitFor(() => expect(onConnected).toHaveBeenCalledWith("do-nyc1-prod"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web exec vitest run src/shell/ConnectWizard.test.tsx`
Expected: FAIL ("Cannot find module './ConnectWizard'").

- [ ] **Step 3: Create `apps/web/src/shell/ConnectWizard.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  type ProviderDescriptor, type CloudCluster, type CheckResult, nextStepFromCheck,
} from "@rigel/cloud-connect/src/index";
import {
  cloudCheck as defaultCheck, cloudListClusters as defaultList, cloudConnect as defaultConnect,
  type CloudProvider,
} from "@/lib/api";

interface Actions {
  check: (provider: CloudProvider) => Promise<CheckResult>;
  list: (provider: CloudProvider) => Promise<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>;
  connect: (provider: CloudProvider, cluster: CloudCluster) => Promise<{ context?: string; backupPath?: string | null }>;
}

const defaultActions: Actions = { check: defaultCheck, list: defaultList, connect: defaultConnect };

type Phase = "checking" | "needs-cli" | "needs-extra" | "needs-login" | "listing" | "pick" | "connecting" | "error";

function CommandBlock({ command }: { command: string }) {
  return (
    <code style={{
      display: "block", fontFamily: "var(--font-mono, monospace)", fontSize: 12, padding: "6px 8px",
      borderRadius: 6, background: "var(--surface-primary)", border: "1px solid var(--border-strong)",
      color: "var(--fg-primary)", whiteSpace: "pre-wrap",
    }}>{command}</code>
  );
}

export function ConnectWizard({
  descriptor, actions = defaultActions, onConnected,
}: {
  descriptor: ProviderDescriptor;
  actions?: Actions;
  onConnected: (context?: string) => void;
}) {
  const qc = useQueryClient();
  const provider = descriptor.id;
  const [phase, setPhase] = useState<Phase>("checking");
  const [clusters, setClusters] = useState<CloudCluster[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    setPhase("checking");
    setError(null);
    try {
      const step = nextStepFromCheck(await actions.check(provider));
      if (step === "ready") {
        setPhase("listing");
        const res = await actions.list(provider);
        if (res.error) { setError(res.stderr || res.error); setPhase("error"); return; }
        setClusters(res.clusters ?? []);
        setPhase("pick");
      } else {
        setPhase(step);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "check failed");
      setPhase("error");
    }
  }

  useEffect(() => { void runCheck(); /* eslint-disable-next-line */ }, []);

  async function connect(cluster: CloudCluster) {
    setPhase("connecting");
    setError(null);
    try {
      const r = await actions.connect(provider, cluster);
      qc.invalidateQueries({ queryKey: ["contexts"] });
      toast.success(`Connected to "${cluster.name}"`, {
        description: r.backupPath ? `Kubeconfig backed up to ${r.backupPath}` : undefined,
      });
      onConnected(r.context);
    } catch (e) {
      setError(e instanceof Error ? e.message : "connect failed");
      setPhase("error");
    }
  }

  if (phase === "checking" || phase === "listing" || phase === "connecting") {
    return <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
      {phase === "connecting" ? "Connecting…" : "Checking your setup…"}
    </div>;
  }

  if (phase === "needs-cli" || phase === "needs-extra") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13 }}>Install the {descriptor.displayName} CLI, then re-check:</div>
        <CommandBlock command={`macOS:    ${descriptor.installHelp.macos}\nLinux:    ${descriptor.installHelp.linux}\nWindows:  ${descriptor.installHelp.windows}`} />
        <a href={descriptor.installHelp.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--accent-soft)" }}>Install docs</a>
        <div><Button onClick={() => void runCheck()}>Re-check</Button></div>
      </div>
    );
  }

  if (phase === "needs-login") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13 }}>{descriptor.loginHelp.explanation}</div>
        <CommandBlock command={descriptor.loginHelp.command} />
        <div><Button onClick={() => void runCheck()}>Re-check</Button></div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "var(--danger, #e5484d)", fontSize: 13 }}>{error}</div>
        <div><Button onClick={() => void runCheck()}>Try again</Button></div>
      </div>
    );
  }

  // pick
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {clusters.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>No clusters found in this account.</div>
      ) : clusters.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-label={`Connect ${c.name}`}
          onClick={() => void connect(c)}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px",
            borderRadius: 8, cursor: "pointer", textAlign: "left",
            background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
          }}
        >
          <span style={{ fontWeight: 600 }}>{c.name}</span>
          <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{c.region}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/web exec vitest run src/shell/ConnectWizard.test.tsx`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/ConnectWizard.tsx apps/web/src/shell/ConnectWizard.test.tsx
git commit -m "feat(web): connect wizard state machine (DigitalOcean path)"
```

---

## Task 12: `ConnectClusterModal` (provider grid + routing)

**Files:**
- Create: `apps/web/src/shell/ConnectClusterModal.tsx`
- Create: `apps/web/src/shell/ConnectClusterModal.test.tsx`

- [ ] **Step 1: Write the failing test `apps/web/src/shell/ConnectClusterModal.test.tsx`**

```tsx
// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectClusterModal } from "./ConnectClusterModal";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("renders DigitalOcean, Import, and 'coming soon' providers", () => {
  wrap(<ConnectClusterModal open onOpenChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: /digitalocean/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /import a kubeconfig/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /amazon eks/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /google gke/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /azure aks/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web exec vitest run src/shell/ConnectClusterModal.test.tsx`
Expected: FAIL ("Cannot find module './ConnectClusterModal'").

- [ ] **Step 3: Create `apps/web/src/shell/ConnectClusterModal.tsx`**

```tsx
import { useEffect, useState } from "react";
import { SiDigitalocean } from "react-icons/si";
import { Cloud, Upload } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { listCloudProviders, type ProviderDescriptor } from "@rigel/cloud-connect/src/index";
import { ConnectWizard } from "./ConnectWizard";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";

type Selection = { kind: "provider"; descriptor: ProviderDescriptor } | { kind: "import" } | null;

const COMING_SOON = [
  { id: "aws", label: "Amazon EKS" },
  { id: "gcp", label: "Google GKE" },
  { id: "azure", label: "Azure AKS" },
];

function ProviderTile({
  label, icon, disabled, onClick,
}: { label: string; icon: React.ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "16px 10px",
        borderRadius: 10, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1,
        background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      {icon}
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      {disabled ? <span style={{ fontSize: 10, color: "var(--fg-tertiary)" }}>Coming soon</span> : null}
    </button>
  );
}

export function ConnectClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => { if (open) setSelection(null); }, [open]);

  const providers = listCloudProviders();
  const title = selection?.kind === "provider"
    ? `Connect to ${selection.descriptor.displayName}`
    : selection?.kind === "import" ? "Import a kubeconfig" : "Connect a cluster";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} icon={<Cloud className="size-[17px]" />} maxWidth="!max-w-md">
      {selection === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {providers.map((d) => (
            <ProviderTile
              key={d.id}
              label={d.displayName}
              icon={<SiDigitalocean size={26} />}
              onClick={() => setSelection({ kind: "provider", descriptor: d })}
            />
          ))}
          <ProviderTile label="Import a kubeconfig" icon={<Upload size={26} />} onClick={() => setSelection({ kind: "import" })} />
          {COMING_SOON.map((p) => (
            <ProviderTile key={p.id} label={p.label} icon={<Cloud size={26} />} disabled />
          ))}
        </div>
      ) : selection.kind === "provider" ? (
        <ConnectWizard descriptor={selection.descriptor} onConnected={() => onOpenChange(false)} />
      ) : (
        <ImportKubeconfigPanel onDone={() => onOpenChange(false)} />
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/web exec vitest run src/shell/ConnectClusterModal.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/ConnectClusterModal.tsx apps/web/src/shell/ConnectClusterModal.test.tsx
git commit -m "feat(web): connect-cluster modal with provider grid + import"
```

---

## Task 13: `AddClusterChooser` + wire the rail `+`

**Files:**
- Create: `apps/web/src/shell/AddClusterChooser.tsx`
- Create: `apps/web/src/shell/AddClusterChooser.test.tsx`
- Modify: `apps/web/src/shell/ClusterRail.tsx` (imports line 10; state line 28; `+` onClick lines 137-149; modal renders near line 183)

- [ ] **Step 1: Write the failing test `apps/web/src/shell/AddClusterChooser.test.tsx`**

```tsx
// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddClusterChooser } from "./AddClusterChooser";

test("offers create-local and connect-existing and fires the right callback", () => {
  const onCreateLocal = vi.fn();
  const onConnectExisting = vi.fn();
  render(<AddClusterChooser open onOpenChange={vi.fn()} onCreateLocal={onCreateLocal} onConnectExisting={onConnectExisting} />);

  fireEvent.click(screen.getByRole("button", { name: /create a local cluster/i }));
  expect(onCreateLocal).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /connect to an existing cluster/i }));
  expect(onConnectExisting).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web exec vitest run src/shell/AddClusterChooser.test.tsx`
Expected: FAIL ("Cannot find module './AddClusterChooser'").

- [ ] **Step 3: Create `apps/web/src/shell/AddClusterChooser.tsx`**

```tsx
import { Boxes, Cloud, PlusCircle } from "lucide-react";
import { Modal } from "@/components/ui/modal";

function ChoiceRow({
  icon, title, subtitle, onClick,
}: { icon: React.ReactNode; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={title}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, cursor: "pointer",
        textAlign: "left", background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      <span style={{ color: "var(--accent-soft)" }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>{subtitle}</span>
      </span>
    </button>
  );
}

export function AddClusterChooser({
  open, onOpenChange, onCreateLocal, onConnectExisting,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreateLocal: () => void;
  onConnectExisting: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a cluster" icon={<PlusCircle className="size-[17px]" />} maxWidth="!max-w-md">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ChoiceRow icon={<Boxes size={20} />} title="Create a local cluster" subtitle="Spin up kind or k3d on this machine" onClick={onCreateLocal} />
        <ChoiceRow icon={<Cloud size={20} />} title="Connect to an existing cluster" subtitle="DigitalOcean, or import a kubeconfig" onClick={onConnectExisting} />
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/web exec vitest run src/shell/AddClusterChooser.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Wire the chooser into `ClusterRail.tsx` — imports (line ~10)**

After `import { CreateClusterModal } from "./CreateClusterModal";` add:

```tsx
import { AddClusterChooser } from "./AddClusterChooser";
import { ConnectClusterModal } from "./ConnectClusterModal";
```

- [ ] **Step 6: Add modal state (line ~28, next to `createOpen`)**

Replace:

```tsx
  const [createOpen, setCreateOpen] = useState(false);
```

with:

```tsx
  const [chooserOpen, setChooserOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
```

- [ ] **Step 7: Point the `+` button at the chooser (lines ~137-149)**

Change the `+` button's `onClick={() => setCreateOpen(true)}` to:

```tsx
          onClick={() => setChooserOpen(true)}
```

- [ ] **Step 8: Render the chooser + connect modal next to the existing create modal (line ~183)**

Replace:

```tsx
      <CreateClusterModal open={createOpen} onOpenChange={setCreateOpen} />
```

with:

```tsx
      <AddClusterChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onCreateLocal={() => { setChooserOpen(false); setCreateOpen(true); }}
        onConnectExisting={() => { setChooserOpen(false); setConnectOpen(true); }}
      />
      <CreateClusterModal open={createOpen} onOpenChange={setCreateOpen} />
      <ConnectClusterModal open={connectOpen} onOpenChange={setConnectOpen} />
```

- [ ] **Step 9: Typecheck + run the rail-related tests**

Run: `pnpm -C apps/web typecheck && pnpm -C apps/web exec vitest run src/shell/AddClusterChooser.test.tsx`
Expected: no type errors; 1 passed.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/shell/AddClusterChooser.tsx apps/web/src/shell/AddClusterChooser.test.tsx apps/web/src/shell/ClusterRail.tsx
git commit -m "feat(web): add-cluster chooser routes to create-local vs connect-existing"
```

---

## Task 14: "Needs re-login" badge on the active cloud tile

The badge is presentational; the health data lives in `ClusterRail` via `useClusterHealth`, gated to the active context when it's a cloud provider.

**Files:**
- Create: `apps/web/src/shell/ClusterHealthBadge.tsx`
- Create: `apps/web/src/shell/ClusterHealthBadge.test.tsx`
- Modify: `apps/web/src/shell/ClusterRail.tsx`

- [ ] **Step 1: Write the failing test `apps/web/src/shell/ClusterHealthBadge.test.tsx`**

```tsx
// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClusterHealthBadge } from "./ClusterHealthBadge";

test("renders a re-login affordance and fires onReconnect when clicked", () => {
  const onReconnect = vi.fn();
  render(<ClusterHealthBadge onReconnect={onReconnect} />);
  const btn = screen.getByRole("button", { name: /needs re-login/i });
  fireEvent.click(btn);
  expect(onReconnect).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web exec vitest run src/shell/ClusterHealthBadge.test.tsx`
Expected: FAIL ("Cannot find module './ClusterHealthBadge'").

- [ ] **Step 3: Create `apps/web/src/shell/ClusterHealthBadge.tsx`**

```tsx
import { AlertTriangle } from "lucide-react";

/** A small overlay dot shown on a cloud tile whose login has expired. */
export function ClusterHealthBadge({ onReconnect }: { onReconnect: () => void }) {
  return (
    <button
      type="button"
      aria-label="Needs re-login"
      title="Login expired — click to re-connect"
      onClick={onReconnect}
      style={{
        position: "absolute", top: -2, right: -2, width: 16, height: 16, borderRadius: 8, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
        background: "var(--danger, #e5484d)", border: "2px solid var(--surface-primary)", color: "#fff",
      }}
    >
      <AlertTriangle size={9} />
    </button>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C apps/web exec vitest run src/shell/ClusterHealthBadge.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Wire health detection into `ClusterRail.tsx`**

Add to the imports (line ~10 area):

```tsx
import { ClusterHealthBadge } from "./ClusterHealthBadge";
import { useClusterHealth } from "@/lib/api";
```

After the existing context/active-context derivation in the component body (where `activeContext` and the contexts list are available; near the existing `const deleteCluster = useDeleteCluster();` at line ~29), add:

```tsx
  // Probe only the ACTIVE cloud context; the badge surfaces an expired login.
  const active = contexts.find((c) => c.active) ?? null;
  const activeProvider = active ? classifyProvider(active) : "generic";
  const isCloud = ["digitalocean", "aws", "gcp", "azure"].includes(activeProvider);
  const health = useClusterHealth(active?.name ?? null, activeProvider, isCloud);
```

> Note: `classifyProvider` is already imported in `ClusterRail.tsx` (used for tile icons). `contexts` is the array the rail already maps over to render tiles — reuse that same variable name; if it is named differently in the file (e.g. `data`), use that.

In the per-tile wrapper `<div style={{ position: "relative", ... }}>` (the tile wrapper at line ~76 that already hosts the active-indicator `<span>`), add the badge as a sibling, shown only for the active cloud tile when its login expired:

```tsx
                {c.active && isCloud && health.data?.authExpired ? (
                  <ClusterHealthBadge onReconnect={() => setConnectOpen(true)} />
                ) : null}
```

- [ ] **Step 6: Typecheck + run web tests**

Run: `pnpm -C apps/web typecheck && pnpm -C apps/web exec vitest run src/shell/ClusterHealthBadge.test.tsx`
Expected: no type errors; 1 passed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/shell/ClusterHealthBadge.tsx apps/web/src/shell/ClusterHealthBadge.test.tsx apps/web/src/shell/ClusterRail.tsx
git commit -m "feat(web): needs-re-login badge on the active cloud tile"
```

---

## Task 15: Full verification + manual-test note

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `pnpm -r typecheck`
Expected: no errors.

- [ ] **Step 2: Run the whole test suite**

Run: `pnpm -r test`
Expected: all packages pass (new: cloud-connect 5+3+4, k8s run env 2, server entitlements 1 + cloudConnect 11, web 5 component suites).

- [ ] **Step 3: Build**

Run: `pnpm -r build`
Expected: succeeds.

- [ ] **Step 4: Rebuild the desktop bundle and smoke-test the wizard UI**

Run: `pnpm --filter desktop dev`
Then in the app: click the rail `+` → "Add a cluster" chooser appears → "Connect to an existing cluster" → the provider grid shows DigitalOcean (enabled), Import (enabled), and AWS/GCP/Azure (disabled, "Coming soon"). Open Import → paste a kubeconfig → it merges and a new tile appears.

- [ ] **Step 5: Manual end-to-end DigitalOcean note**

End-to-end DigitalOcean connect requires a real DO account + `doctl` installed and `doctl auth init` run, which are not on the dev machine — so this is a **manual verification step** (like local kind/k3d create was). With `doctl` present and logged in: rail `+` → Connect existing → DigitalOcean → the wizard lists your DOKS clusters → pick one → it runs `doctl kubernetes cluster kubeconfig save <id>` and the new tile appears, refreshing its token in perpetuity via doctl's exec credential. If `doctl` is missing or logged out, the wizard shows the install/login help instead.

- [ ] **Step 6: Final commit (if any uncommitted verification fixups)**

```bash
git add -A
git commit -m "chore(cloud-connect): verification fixups" || echo "nothing to commit"
```

---

## Out of scope (carried from the spec)

- Cloud cluster **creation** (connect-only here).
- **Self-managed auth / token minting**; Rigel stores no cloud credentials.
- AWS/GCP/Azure **descriptors** (the engine supports them; add a descriptor per provider as fast-follow — each is a new `ProviderDescriptor` in `descriptors.ts` + entry in `DESCRIPTORS`, an install/login/relogin help block, and its `parseClusterList`; the GCP descriptor must set `extraBinaries: ["gke-gcloud-auth-plugin"]` and AKS may need `kubelogin`).
- **User accounts / billing / Stripe** (Stream 2 / HELM-15) and **enforcing** `canConnect` (Stream 3 / HELM-16).
- Health probing of **non-active** cloud tiles (v1 probes only the active context to keep process spawns minimal).
