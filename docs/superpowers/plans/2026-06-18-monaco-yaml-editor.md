# Monaco YAML Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Monaco-based `<YamlEditor>` with live-cluster Kubernetes schema awareness, mounted in three surfaces — Apply YAML (+ file upload), live-resource editing (Deployments/ConfigMaps/Secrets), and GitOps repo files.

**Architecture:** One shared lazy-loaded editor component (Monaco + `monaco-yaml`) backed by a server endpoint that converts the apiserver's OpenAPI v2 into a JSON Schema. Each consumer reuses existing guarded plumbing: Apply/edit go through the `applyManifest` action + `ConfirmSheet`; GitOps goes through `proposeRepoFix`. No new mutation paths. On schema failure the editor degrades to YAML-lint only (no static fallback).

**Tech Stack:** React 19 + Vite + TypeScript; `monaco-editor@0.55.1`, `@monaco-editor/react@4.7.0`, `monaco-yaml@5.5.1`; Bun server; `@rigel/k8s` shared package; vitest (web) / `bun test` (server + packages).

**Spec:** `docs/superpowers/specs/2026-06-18-monaco-yaml-editor-design.md`

---

## Conventions for every task

- Web tests: vitest. Pure-logic suites run in node; component/DOM suites start the file with `// @vitest-environment jsdom`. Run with `pnpm --filter web test`.
- Server + `packages/*` tests: `bun test` (`import { test, expect } from "bun:test"`). Run with `pnpm --filter @rigel/k8s test` / `pnpm --filter @rigel/server test`.
- Monaco UI wiring can't be meaningfully unit-tested (workers/canvas). We extract all testable logic into pure modules (tested) and verify the editor itself **manually in the running Docker container** (`docker compose up -d --build`, per the project rule that the web app runs as a local container).
- Commit after each task. Keep commits scoped to the task.

---

## Phase 0 — Dependencies

### Task 0: Add Monaco packages

**Files:**
- Modify: `apps/web/package.json` (via pnpm)

- [ ] **Step 1: Install the latest editor packages**

Run:
```bash
pnpm --filter web add monaco-editor@latest @monaco-editor/react@latest monaco-yaml@latest
```
Expected: `package.json` gains `monaco-editor`, `@monaco-editor/react`, `monaco-yaml` (≥ 0.55 / 4.7 / 5.5 respectively).

- [ ] **Step 2: Ensure Vite pre-bundles monaco**

Modify `apps/web/vite.config.ts` — add `optimizeDeps` so Monaco's ESM resolves cleanly under Vite. Insert after the `plugins` array:

```ts
  optimizeDeps: {
    include: ["monaco-editor", "@monaco-editor/react", "monaco-yaml"],
  },
```

- [ ] **Step 3: Verify the build still works**

Run: `pnpm --filter web build`
Expected: build succeeds (no Monaco imported yet, so bundle size is unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/vite.config.ts pnpm-lock.yaml
git commit -m "build(web): add monaco-editor, @monaco-editor/react, monaco-yaml"
```

---

## Phase 1 — Schema pipeline

### Task 1: OpenAPI v2 → monaco-yaml JSON Schema converter (pure)

**Files:**
- Create: `packages/k8s/src/openapiSchema.ts`
- Test: `packages/k8s/src/openapiSchema.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/k8s/src/openapiSchema.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openapiV2ToYamlSchema, gvkApiVersion } from "./openapiSchema";

const SAMPLE = {
  definitions: {
    "io.k8s.api.apps.v1.Deployment": {
      type: "object",
      "x-kubernetes-group-version-kind": [{ group: "apps", version: "v1", kind: "Deployment" }],
      properties: { spec: { type: "object" } },
    },
    "io.k8s.api.core.v1.ConfigMap": {
      type: "object",
      "x-kubernetes-group-version-kind": [{ group: "", version: "v1", kind: "ConfigMap" }],
    },
    "io.k8s.apimachinery.SomeInternalType": { type: "object" }, // no GVK → skipped
  },
};

test("gvkApiVersion: core group omits the slash, others are group/version", () => {
  expect(gvkApiVersion({ group: "", version: "v1" })).toBe("v1");
  expect(gvkApiVersion({ group: "apps", version: "v1" })).toBe("apps/v1");
});

test("openapiV2ToYamlSchema builds one oneOf branch per GVK with const discriminators", () => {
  const schema = openapiV2ToYamlSchema(SAMPLE);
  expect(schema).not.toBeNull();
  const branches = schema!.oneOf as Array<Record<string, any>>;
  expect(branches).toHaveLength(2); // internal type with no GVK is skipped
  const deploy = branches.find((b) => b.properties.kind.const === "Deployment")!;
  expect(deploy.properties.apiVersion.const).toBe("apps/v1");
  expect(deploy.required).toEqual(["apiVersion", "kind"]);
  expect(deploy.allOf[0].$ref).toBe("#/definitions/io.k8s.api.apps.v1.Deployment");
  // definitions carried through so the $refs resolve.
  expect((schema!.definitions as Record<string, unknown>)["io.k8s.api.core.v1.ConfigMap"]).toBeDefined();
});

test("openapiV2ToYamlSchema returns null on junk input (→ lint-only)", () => {
  expect(openapiV2ToYamlSchema(null)).toBeNull();
  expect(openapiV2ToYamlSchema({})).toBeNull();
  expect(openapiV2ToYamlSchema({ definitions: {} })).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rigel/k8s test openapiSchema`
Expected: FAIL — `openapiV2ToYamlSchema is not a function` (module doesn't exist).

- [ ] **Step 3: Implement the converter**

Create `packages/k8s/src/openapiSchema.ts`:

```ts
// Converts a Kubernetes apiserver OpenAPI v2 (Swagger) document into a single
// JSON Schema for monaco-yaml: a top-level `oneOf` over every GroupVersionKind,
// each branch pinning apiVersion+kind so each `---` document in a multi-doc
// manifest validates against the right resource (core kinds AND the cluster's
// CRDs). Returns null when the input isn't a usable OpenAPI v2 doc — the caller
// then runs the editor lint-only (no static fallback, by design).

interface OpenApiV2 {
  definitions?: Record<string, OpenApiDefinition>;
}
interface GVK { group: string; version: string; kind: string }
interface OpenApiDefinition {
  "x-kubernetes-group-version-kind"?: GVK[];
  [k: string]: unknown;
}

/** apiVersion string for a GVK: "v1" for the core group, else "group/version". */
export function gvkApiVersion(gvk: { group: string; version: string }): string {
  return gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
}

export function openapiV2ToYamlSchema(raw: unknown): Record<string, unknown> | null {
  const doc = raw as OpenApiV2 | null;
  if (!doc || typeof doc !== "object" || !doc.definitions || typeof doc.definitions !== "object") {
    return null;
  }
  const oneOf: Array<Record<string, unknown>> = [];
  for (const [defName, def] of Object.entries(doc.definitions)) {
    const gvks = def?.["x-kubernetes-group-version-kind"];
    if (!Array.isArray(gvks) || gvks.length === 0) continue;
    for (const gvk of gvks) {
      if (!gvk?.kind || !gvk?.version) continue;
      oneOf.push({
        type: "object",
        required: ["apiVersion", "kind"],
        properties: {
          apiVersion: { const: gvkApiVersion(gvk) },
          kind: { const: gvk.kind },
        },
        allOf: [{ $ref: `#/definitions/${defName}` }],
      });
    }
  }
  if (oneOf.length === 0) return null;
  return { definitions: doc.definitions as Record<string, unknown>, oneOf };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rigel/k8s test openapiSchema`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the package index**

In `packages/k8s/src/index.ts`, add alongside the other exports:

```ts
export { openapiV2ToYamlSchema, gvkApiVersion } from "./openapiSchema";
```

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/openapiSchema.ts packages/k8s/src/openapiSchema.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): OpenAPI v2 → monaco-yaml JSON Schema converter"
```

### Task 2: Top-level `status:` stripper for the live-edit clean read (pure)

**Files:**
- Create: `packages/k8s/src/manifestClean.ts`
- Test: `packages/k8s/src/manifestClean.test.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/k8s/src/manifestClean.test.ts`:

```ts
import { test, expect } from "bun:test";
import { stripStatusBlock } from "./manifestClean";

test("stripStatusBlock drops a top-level status block, keeps the rest", () => {
  const input = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    "  replicas: 2",
    "status:",
    "  readyReplicas: 2",
    "  conditions:",
    "  - type: Available",
  ].join("\n");
  const out = stripStatusBlock(input);
  expect(out).toContain("kind: Deployment");
  expect(out).toContain("replicas: 2");
  expect(out).not.toContain("status:");
  expect(out).not.toContain("readyReplicas");
});

test("stripStatusBlock keeps a status block that ends before another top-level key", () => {
  const input = ["kind: Deployment", "status:", "  ready: 1", "spec:", "  replicas: 3"].join("\n");
  const out = stripStatusBlock(input);
  expect(out).not.toContain("ready: 1");
  expect(out).toContain("replicas: 3"); // spec after status survives
});

test("stripStatusBlock leaves an indented status: key (e.g. configmap data) untouched", () => {
  const input = "apiVersion: v1\nkind: ConfigMap\ndata:\n  status: not-a-block\n";
  expect(stripStatusBlock(input)).toBe(input);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rigel/k8s test manifestClean`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stripper**

Create `packages/k8s/src/manifestClean.ts`:

```ts
// Hand-rolled manifest tidy for the live-resource editor — no YAML dependency in
// the bundle (matches the project's other hand-rolled YAML editors). Removes the
// top-level `status:` block (server-computed, not meant to be edited/applied).
// managedFields are excluded upstream via `kubectl get --show-managed-fields=false`.

/** Drop a top-level `status:` mapping from single-doc `kubectl get -o yaml`
 *  output. A top-level key sits at column 0; the block runs until the next
 *  column-0 key or EOF. An indented `status:` (a data/spec key) is left alone. */
export function stripStatusBlock(yaml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of yaml.split("\n")) {
    if (skipping) {
      if (line === "" || /^\s/.test(line)) continue; // still inside status:
      skipping = false; // a new column-0 key ends the block
    }
    if (/^status:(\s|$)/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rigel/k8s test manifestClean`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the package index**

In `packages/k8s/src/index.ts`:

```ts
export { stripStatusBlock } from "./manifestClean";
```

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/manifestClean.ts packages/k8s/src/manifestClean.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): stripStatusBlock for the live-resource edit read"
```

### Task 3: Server schema endpoint + cleaned resource read

**Files:**
- Create: `apps/server/src/clusterSchema.ts`
- Modify: `apps/server/src/index.ts` (imports; `/api/resource` handler ~line 314; new `/api/openapi-schema` route)

- [ ] **Step 1: Implement the cached schema fetcher**

Create `apps/server/src/clusterSchema.ts`:

```ts
// Fetches the apiserver's OpenAPI v2 (Swagger) document and converts it to a
// monaco-yaml JSON Schema, cached per kube-context for the process lifetime
// (CRDs/version change rarely; a server restart re-fetches). Returns null when
// the fetch or conversion fails — the client edits lint-only (NO static fallback).
import { kubectl } from "@rigel/k8s/src/run";
import { openapiV2ToYamlSchema } from "@rigel/k8s/src/openapiSchema";

const cache = new Map<string, Record<string, unknown> | null>();

export async function getClusterYamlSchema(context: string | null): Promise<Record<string, unknown> | null> {
  const key = context ?? "__current__";
  if (cache.has(key)) return cache.get(key) ?? null;
  const res = await kubectl(context, ["get", "--raw", "/openapi/v2"]);
  let schema: Record<string, unknown> | null = null;
  if (res.code === 0) {
    try {
      schema = openapiV2ToYamlSchema(JSON.parse(res.stdout));
    } catch {
      schema = null;
    }
  }
  cache.set(key, schema);
  return schema;
}
```

- [ ] **Step 2: Wire the new route + cleaned read into the server**

In `apps/server/src/index.ts`:

(a) Add the import near the other `./` imports (after line ~23):
```ts
import { getClusterYamlSchema } from "./clusterSchema";
```
(b) Add `stripStatusBlock` to the existing `@rigel/k8s` usage — add this import line near the top:
```ts
import { stripStatusBlock } from "@rigel/k8s/src/manifestClean";
```
(c) Replace the `/api/resource` handler body (currently lines 314–322) with a `clean`-aware version:
```ts
    if (url.pathname === "/api/resource" && req.method === "GET") {
      const kind = url.searchParams.get("kind");
      const name = url.searchParams.get("name");
      const namespace = url.searchParams.get("namespace");
      const clean = url.searchParams.get("clean") === "1";
      if (!kind || !name) return Response.json({ error: "missing kind or name" }, { status: 422 });
      const args = [
        "get", kind, name, "-o", "yaml",
        ...(clean ? ["--show-managed-fields=false"] : []),
        ...(namespace ? ["-n", namespace] : []),
      ];
      const res = await kubectl(context, args);
      const yamlOut = clean && res.code === 0 ? stripStatusBlock(res.stdout) : res.stdout;
      return Response.json({ code: res.code, yaml: yamlOut, stderr: res.stderr });
    }
```
(d) Immediately after that block, add the schema route:
```ts
    // GET /api/openapi-schema — the live cluster's OpenAPI v2 converted to a
    // monaco-yaml JSON Schema (cached per context). { schema } or { schema: null }
    // when unavailable; the client then edits lint-only (no static fallback).
    if (url.pathname === "/api/openapi-schema" && req.method === "GET") {
      return Response.json({ schema: await getClusterYamlSchema(context) });
    }
```

- [ ] **Step 3: Verify the server typechecks/builds**

Run: `pnpm --filter @rigel/server build`
Expected: build succeeds.

- [ ] **Step 4: Verify the endpoint returns a schema against the live cluster**

Run (server must be running locally on :8787, or start it):
```bash
curl -s localhost:8787/api/openapi-schema | head -c 200
```
Expected: JSON beginning `{"schema":{"definitions":...` (or `{"schema":null}` if the cluster's `/openapi/v2` is unreachable — that's the documented degraded path, not a bug). This is a READ-only endpoint, safe to call.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/clusterSchema.ts apps/server/src/index.ts
git commit -m "feat(server): /api/openapi-schema + cleaned /api/resource?clean=1 read"
```

---

## Phase 2 — Core `<YamlEditor>`

### Task 4: Monaco + monaco-yaml bootstrap (workers, theme, schema binding)

**Files:**
- Create: `apps/web/src/components/monaco/setup.ts`

- [ ] **Step 1: Write the bootstrap module**

Create `apps/web/src/components/monaco/setup.ts`:

```ts
// One-time Monaco + monaco-yaml bootstrap. Imported by YamlEditor (which is
// itself lazy-loaded), so Monaco's bundle + workers only load when a YAML surface
// first opens. Wires the Vite `?worker` bundles into MonacoEnvironment and binds
// monaco-yaml to the same monaco instance @monaco-editor/react uses.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import yamlWorker from "monaco-yaml/yaml.worker?worker";
import { configureMonacoYaml, type MonacoYaml } from "monaco-yaml";

// Route worker requests: only "yaml" needs the YAML language server.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "yaml") return new yamlWorker();
    return new editorWorker();
  },
};

// Use the locally-bundled monaco (not the CDN) so monaco-yaml attaches to the
// same instance the React wrapper renders.
loader.config({ monaco });

export const HELMSMAN_THEME = "rigel-dark";

let themeDefined = false;
let yamlHandle: MonacoYaml | null = null;

/** Idempotently define the app theme + bind monaco-yaml. Returns the monaco-yaml
 *  handle so callers can push schema updates via `.update({ schemas })`. */
export function ensureMonacoYaml(m: typeof monaco): MonacoYaml {
  if (!themeDefined) {
    m.editor.defineTheme(HELMSMAN_THEME, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#08080A",
        "editorLineNumber.foreground": "#3A3A40",
        "editor.lineHighlightBackground": "#141417",
      },
    });
    themeDefined = true;
  }
  if (!yamlHandle) {
    yamlHandle = configureMonacoYaml(m, {
      enableSchemaRequest: false,
      validate: true,
      format: true,
      hover: true,
      completion: true,
      schemas: [],
    });
  }
  return yamlHandle;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter web typecheck`
Expected: passes. (If `monaco-yaml/yaml.worker?worker` lacks types, add `apps/web/src/vite-env.d.ts` with `/// <reference types="vite/client" />` if not already present — check first with `cat apps/web/src/vite-env.d.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/monaco/setup.ts
git commit -m "feat(web): Monaco + monaco-yaml bootstrap (workers, theme, schema)"
```

### Task 5: The `<YamlEditor>` component + lazy boundary + schema hook

**Files:**
- Create: `apps/web/src/components/YamlEditor.tsx`
- Create: `apps/web/src/components/YamlEditorLazy.tsx`
- Create: `apps/web/src/lib/useClusterYamlSchema.ts`

- [ ] **Step 1: Write the editor component**

Create `apps/web/src/components/YamlEditor.tsx`:

```tsx
// Reusable YAML editor (Monaco + monaco-yaml). DEFAULT export so it can be
// React.lazy()'d — keeps Monaco out of the initial bundle. The optional `schema`
// (the live cluster JSON Schema) drives autocomplete + inline validation; when
// null the editor runs lint-only.
import { useEffect, useId, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { ensureMonacoYaml, HELMSMAN_THEME } from "./monaco/setup";

export interface YamlEditorProps {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  /** Cluster JSON Schema for validation/autocomplete, or null for lint-only. */
  schema?: Record<string, unknown> | null;
  /** CSS height; defaults to filling the parent. */
  height?: string;
}

export default function YamlEditor({ value, onChange, readOnly, schema, height = "100%" }: YamlEditorProps) {
  const yamlRef = useRef<ReturnType<typeof ensureMonacoYaml> | null>(null);
  // Unique in-memory model URI per instance so concurrently-mounted editors
  // never share a Monaco model. monaco-yaml's `fileMatch: ["*"]` still applies
  // the schema to every model regardless of the URI.
  const modelUri = `inmemory://model/${useId().replace(/:/g, "")}.yaml`;

  function applySchema() {
    yamlRef.current?.update({
      enableSchemaRequest: false,
      schemas: schema
        ? [{ uri: "inmemory://schema/kubernetes.json", fileMatch: ["*"], schema }]
        : [],
    });
  }

  const handleMount: OnMount = (_editor, monaco) => {
    yamlRef.current = ensureMonacoYaml(monaco);
    applySchema();
  };

  // Push schema changes (it may arrive after the editor mounts) into monaco-yaml.
  useEffect(() => {
    applySchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  return (
    <Editor
      height={height}
      language="yaml"
      theme={HELMSMAN_THEME}
      path={modelUri}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12.5,
        lineNumbers: "on",
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontFamily: "ui-monospace, 'Geist Mono', monospace",
      }}
      loading={<div style={{ padding: 16, fontSize: 13, color: "var(--fg-tertiary)" }}>Loading editor…</div>}
    />
  );
}
```

- [ ] **Step 2: Write the lazy boundary**

Create `apps/web/src/components/YamlEditorLazy.tsx`:

```tsx
// Lazy boundary for the Monaco-based YamlEditor — defers the editor bundle +
// workers until a YAML surface actually renders. Consumers import THIS, never
// the heavy ./YamlEditor module directly.
import { lazy, Suspense } from "react";
import type { YamlEditorProps } from "./YamlEditor";

const Inner = lazy(() => import("./YamlEditor"));

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense
      fallback={<div style={{ padding: 16, fontSize: 13, color: "var(--fg-tertiary)" }}>Loading editor…</div>}
    >
      <Inner {...props} />
    </Suspense>
  );
}
```

- [ ] **Step 3: Write the schema query hook**

Create `apps/web/src/lib/useClusterYamlSchema.ts`:

```ts
import { useQuery } from "@tanstack/react-query";

/** Live cluster JSON Schema for YAML editing, or null when unavailable
 *  (editors then run lint-only). Fetched once and cached for the session. */
async function fetchClusterYamlSchema(): Promise<Record<string, unknown> | null> {
  const res = await fetch("/api/openapi-schema");
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { schema?: Record<string, unknown> | null };
  return data.schema ?? null;
}

export function useClusterYamlSchema() {
  return useQuery({
    queryKey: ["openapi-schema"] as const,
    queryFn: fetchClusterYamlSchema,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
```

- [ ] **Step 4: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass. The build output should now contain a SEPARATE Monaco chunk (lazy) — confirm the main entry chunk did not balloon (Monaco should be in its own async chunk).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/YamlEditor.tsx apps/web/src/components/YamlEditorLazy.tsx apps/web/src/lib/useClusterYamlSchema.ts
git commit -m "feat(web): reusable <YamlEditor> (lazy) + cluster schema hook"
```

---

## Phase 3 — Consumer A: Apply YAML panel

### Task 6: File-read helper for upload/drag-drop (pure)

**Files:**
- Create: `apps/web/src/panels/apply/readYamlFile.ts`
- Test: `apps/web/src/panels/apply/readYamlFile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/apply/readYamlFile.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { isYamlFilename, readYamlFile } from "./readYamlFile";

test("isYamlFilename accepts .yaml/.yml, rejects others", () => {
  expect(isYamlFilename("deploy.yaml")).toBe(true);
  expect(isYamlFilename("deploy.YML")).toBe(true);
  expect(isYamlFilename("notes.txt")).toBe(false);
  expect(isYamlFilename("yaml")).toBe(false);
});

test("readYamlFile returns the file text for a yaml file", async () => {
  const file = new File(["kind: Pod\n"], "pod.yaml", { type: "text/yaml" });
  expect(await readYamlFile(file)).toBe("kind: Pod\n");
});

test("readYamlFile rejects a non-yaml file", async () => {
  const file = new File(["{}"], "data.json");
  await expect(readYamlFile(file)).rejects.toThrow(/not a \.yaml/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test readYamlFile`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/panels/apply/readYamlFile.ts`:

```ts
// File → YAML text for the Apply panel's upload / drag-drop. Pure + tiny so the
// panel wiring stays thin and this stays unit-testable.

/** True for .yaml / .yml filenames (case-insensitive). */
export function isYamlFilename(name: string): boolean {
  return /\.ya?ml$/i.test(name.trim());
}

/** Read a dropped/selected file's text. Rejects non-YAML extensions so a binary
 *  or JSON blob isn't silently dumped into the manifest editor. */
export async function readYamlFile(file: File): Promise<string> {
  if (!isYamlFilename(file.name)) {
    throw new Error(`${file.name} is not a .yaml/.yml file`);
  }
  return file.text();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web test readYamlFile`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/apply/readYamlFile.ts apps/web/src/panels/apply/readYamlFile.test.ts
git commit -m "feat(web): readYamlFile helper for Apply panel upload"
```

### Task 7: Swap the textarea for `<YamlEditor>` + add upload/drag-drop

**Files:**
- Modify: `apps/web/src/panels/apply/ApplyYamlPanel.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the panel**

Replace the entire contents of `apps/web/src/panels/apply/ApplyYamlPanel.tsx` with:

```tsx
// Apply YAML — paste/type/UPLOAD an arbitrary multi-doc manifest in a Monaco
// editor (k8s schema-aware when the cluster schema is available), validate it
// against the apiserver (kubectl apply --dry-run=server), then apply it through
// the same guarded ConfirmSheet every other mutation uses. Cluster-wide: the
// namespace comes from each document, so this panel is NOT namespace-scoped.
import { useRef, useState } from "react";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { applyManifestYaml, type ActionBlock, type ActionResult } from "@/lib/api";
import { listResources } from "@rigel/catalog";
import { isYamlFilename, readYamlFile } from "./readYamlFile";
import { CheckCircle2, Layers, LoaderCircle, Play, Upload } from "lucide-react";

const PLACEHOLDER = `# Paste, type, or upload a Kubernetes manifest (multi-doc with --- supported)
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world`;

export default function ApplyYamlPanel() {
  const [yaml, setYaml] = useState("");
  const [validate, setValidate] = useState<{ pending: boolean; result?: ActionResult; error?: string }>({ pending: false });
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: schema } = useClusterYamlSchema();

  const hasContent = yaml.trim().length > 0;

  async function handleValidate() {
    if (!hasContent) return;
    setValidate({ pending: true });
    try {
      const result = await applyManifestYaml(yaml, true);
      setValidate({ pending: false, result });
    } catch (e) {
      setValidate({ pending: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function handleApply() {
    if (!hasContent) return;
    setPendingAction({ kind: "applyManifest", label: "Apply YAML", manifest: yaml });
  }

  // Reset stale validation feedback whenever the manifest changes.
  function onChange(next: string) {
    setYaml(next);
    if (validate.result || validate.error) setValidate({ pending: false });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    try {
      onChange(await readYamlFile(file));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  }

  const yamlDrop = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.files).find((f) => isYamlFilename(f.name));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelHeader title="Apply YAML" subtitle="Create or update resources from a pasted, typed, or uploaded manifest">
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,text/yaml"
          hidden
          onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" /> Upload
        </Button>
        <Button variant="outline" size="sm" onClick={handleValidate} disabled={!hasContent || validate.pending}>
          {validate.pending ? <><LoaderCircle className="size-3.5 animate-spin" /> Validating…</> : "Validate"}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!hasContent}>
          <Play className="size-3.5 fill-current" /> Apply…
        </Button>
      </PanelHeader>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void loadFile(yamlDrop(e)); }}
          style={{
            flex: 1,
            minHeight: 0,
            borderRadius: 10,
            overflow: "hidden",
            border: `1px solid ${dragOver ? "var(--accent-primary)" : "#26272B"}`,
            position: "relative",
          }}
        >
          {yaml === "" && (
            <pre
              aria-hidden
              style={{
                position: "absolute", inset: 0, margin: 0, padding: "8px 14px 8px 62px",
                pointerEvents: "none", zIndex: 1, color: "var(--fg-tertiary)",
                fontFamily: "ui-monospace, 'Geist Mono', monospace", fontSize: 12.5, lineHeight: 1.5,
              }}
            >
              {PLACEHOLDER}
            </pre>
          )}
          <YamlEditor value={yaml} onChange={onChange} schema={schema ?? null} />
        </div>

        {uploadError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" style={{ flexShrink: 0 }}>
            {uploadError}
          </p>
        )}
        <ValidationResult state={validate} yaml={yaml} />
      </div>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

/** Renders the dry-run outcome: a green resource summary on success, the
 *  apiserver's error on failure, or a transport error. */
function ValidationResult({ state, yaml }: { state: { pending: boolean; result?: ActionResult; error?: string }; yaml: string }) {
  if (state.error) return <ResultBox tone="error">{state.error}</ResultBox>;
  if (!state.result) return null;
  if (state.result.code !== 0) {
    return <ResultBox tone="error">{state.result.stderr || state.result.stdout || "Validation failed."}</ResultBox>;
  }
  const resources = listResources(yaml);
  return (
    <div className="flex flex-col gap-1.5" style={{ flexShrink: 0 }}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="size-3.5" /> Valid — {resources.length} resource{resources.length === 1 ? "" : "s"} (dry run, nothing applied).
      </p>
      {resources.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-auto rounded-lg p-1.5 text-xs" style={{ background: "#08080A", border: "1px solid #26272B" }}>
          {resources.map((r, i) => (
            <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1 font-mono">
              <Layers className="size-3 shrink-0" style={{ color: "var(--accent-primary)" }} />
              <span className="shrink-0 font-semibold" style={{ color: "var(--accent-primary)" }}>{r.kind}</span>
              <span className="truncate text-foreground/90">{r.name || "—"}</span>
              {r.namespace && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{r.namespace}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResultBox({ tone, children }: { tone: "error"; children: React.ReactNode }) {
  return (
    <pre
      className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 text-xs font-mono"
      style={{ flexShrink: 0, background: tone === "error" ? "rgba(248,113,113,0.10)" : "#08080A", color: "var(--status-failed)", border: "1px solid rgba(248,113,113,0.25)" }}
    >
      {children}
    </pre>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/apply/ApplyYamlPanel.tsx
git commit -m "feat(web): Monaco editor + upload/drag-drop in Apply YAML panel"
```

- [ ] **Step 4: Manual verification (Docker)**

Run: `docker compose up -d --build`
Then in the browser (http://localhost:8787 → Apply YAML): (a) the editor shows syntax highlighting; (b) typing an invalid k8s field on a `Deployment` shows a red squiggle (schema present) — if the cluster has no `/openapi/v2`, you instead get YAML-lint only, which is expected; (c) **Upload** loads a `.yaml` file; (d) drag-drop a `.yaml` file populates the editor; (e) Validate + Apply… still work through the ConfirmSheet.

---

## Phase 4 — Consumer B: Edit a live resource

### Task 8: Add `editable` + `editYaml` to the YAML viewer store

**Files:**
- Modify: `apps/web/src/store/yamlViewer.ts`

- [ ] **Step 1: Extend the store**

In `apps/web/src/store/yamlViewer.ts`, add `editable` to `YamlTarget` and an `editYaml` opener. Replace the `YamlTarget` interface and append `editYaml`:

```ts
export interface YamlTarget {
  /** kubectl kind, e.g. "deployment", "pod", "service", "node". */
  kind: string;
  name: string;
  /** Omit for cluster-scoped kinds (node, namespace, pv, clusterrole…). */
  namespace?: string;
  /** Optional display title (defaults to `kind/name`). */
  title?: string;
  /** When true, the viewer offers an Edit→Apply flow (live-resource editing). */
  editable?: boolean;
}
```

And after the existing `viewYaml` function add:

```ts
/** Open the YAML viewer in EDITABLE mode — same viewer, plus an Edit→Apply flow
 *  that re-applies the manifest through the guarded ConfirmSheet. Separate entry
 *  point from viewYaml so read-only callers are untouched. */
export function editYaml(kind: string, name: string, namespace?: string, title?: string): void {
  useYamlViewer.getState().open({ kind, name, namespace, title, editable: true });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/store/yamlViewer.ts
git commit -m "feat(web): editable mode + editYaml() in the YAML viewer store"
```

### Task 9: Add Edit→Apply to `ResourceYamlViewer`

**Files:**
- Modify: `apps/web/src/components/ResourceYamlViewer.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the viewer to support an edit mode**

Replace the entire contents of `apps/web/src/components/ResourceYamlViewer.tsx` with:

```tsx
// ResourceYamlViewer — YAML view of a cluster resource. Mounted once at the app
// root; opens whenever viewYaml(...) / editYaml(...) is called from any context
// menu. Read-only by default; when the target is `editable`, an Edit button
// switches to a Monaco editor seeded with the CLEANED manifest (status +
// managedFields stripped server-side) and an Apply… button re-applies it through
// the guarded ConfirmSheet (no new mutation path).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, FileCode, Pencil, Play } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { useYamlViewer } from "@/store/yamlViewer";
import type { ActionBlock } from "@/lib/api";

async function fetchResourceYaml(kind: string, name: string, namespace?: string, clean?: boolean): Promise<string> {
  const params = new URLSearchParams({ kind, name });
  if (namespace) params.set("namespace", namespace);
  if (clean) params.set("clean", "1");
  const res = await fetch(`/api/resource?${params.toString()}`);
  const data = (await res.json().catch(() => ({}))) as { code?: number; yaml?: string; stderr?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  if (data.code !== 0) throw new Error(data.stderr || "kubectl get failed");
  return data.yaml ?? "";
}

export function ResourceYamlViewer() {
  const target = useYamlViewer((s) => s.target);
  const close = useYamlViewer((s) => s.close);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [applyAction, setApplyAction] = useState<ActionBlock | null>(null);
  const { data: schema } = useClusterYamlSchema();

  // Reset transient edit state whenever the target changes.
  useEffect(() => { setEditing(false); setDraft(""); }, [target?.kind, target?.name, target?.namespace]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["resource-yaml", target?.kind, target?.name, target?.namespace, target?.editable],
    // Editable targets fetch the CLEANED manifest (ready to re-apply).
    queryFn: () => fetchResourceYaml(target!.kind, target!.name, target!.namespace, target!.editable),
    enabled: !!target,
  });

  if (!target) return null;
  const title = target.title ?? `${target.kind}/${target.name}`;
  const subtitle = target.namespace ? `namespace: ${target.namespace}` : "cluster-scoped";

  function handleCopy() {
    if (!data) return;
    void navigator.clipboard.writeText(data).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function startEdit() {
    setDraft(data ?? "");
    setEditing(true);
  }

  function handleApply() {
    setApplyAction({ kind: "applyManifest", label: `Apply ${title}`, manifest: draft });
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader className="flex-row items-start gap-3">
            <FileCode className="mt-0.5 size-5 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogTitle className="truncate font-mono text-[15px]">{title}</DialogTitle>
              <DialogDescription className="text-xs">
                {subtitle}{editing ? " · editing" : ""}
              </DialogDescription>
            </div>
            {target.editable && !editing && data && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={startEdit}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
            {editing ? (
              <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={draft.trim() === ""}>
                <Play className="size-3.5 fill-current" /> Apply…
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy} disabled={!data}>
                {copied ? <Check className="size-3.5" style={{ color: "#28C840" }} /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </DialogHeader>

          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : isError ? (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-destructive/10 p-3 text-xs font-mono text-destructive whitespace-pre-wrap">
              {error instanceof Error ? error.message : String(error)}
            </pre>
          ) : editing ? (
            <div style={{ height: "65vh", borderRadius: 8, overflow: "hidden", border: "1px solid #26272B" }}>
              <YamlEditor value={draft} onChange={setDraft} schema={schema ?? null} />
            </div>
          ) : (
            <pre
              className="max-h-[65vh] overflow-auto rounded-lg p-3 text-xs font-mono leading-5 whitespace-pre"
              style={{ background: "#08080A", border: "1px solid #26272B" }}
            >
              {data}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmSheet action={applyAction} open={!!applyAction} onClose={() => setApplyAction(null)} />
    </>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ResourceYamlViewer.tsx
git commit -m "feat(web): Edit→Apply mode in ResourceYamlViewer"
```

### Task 10: Wire "Edit YAML…" into Deployments, ConfigMaps, Secrets

**Files:**
- Modify: `apps/web/src/panels/configmaps/ConfigMapsPanel.tsx`
- Modify: `apps/web/src/panels/secrets/SecretsPanel.tsx`
- Modify: `apps/web/src/panels/deployments/DeploymentRow.tsx`

- [ ] **Step 1: ConfigMaps**

In `apps/web/src/panels/configmaps/ConfigMapsPanel.tsx`:
- Change the import on line 6 from `import { viewYaml } from "@/store/yamlViewer";` to:
  ```ts
  import { viewYaml, editYaml } from "@/store/yamlViewer";
  ```
- After the existing `View YAML…` ContextMenuItem (line 138), add:
  ```tsx
  <ContextMenuItem onClick={() => editYaml("configmap", cm.metadata.name, cm.metadata.namespace)}>Edit YAML…</ContextMenuItem>
  ```

- [ ] **Step 2: Secrets**

In `apps/web/src/panels/secrets/SecretsPanel.tsx`:
- First locate the existing View YAML wiring: `grep -n "viewYaml" apps/web/src/panels/secrets/SecretsPanel.tsx`.
- Add `editYaml` to that import: `import { viewYaml, editYaml } from "@/store/yamlViewer";`.
- Immediately after the `View YAML…` ContextMenuItem, add a sibling using the same `(kind, name, namespace)` arguments the View item uses, but `editYaml(...)` and label `Edit YAML…`. (Use `"secret"` as the kind and the same name/namespace expressions already present.)

- [ ] **Step 3: Deployments**

In `apps/web/src/panels/deployments/DeploymentRow.tsx`:
- The file already imports `viewYaml` (line 7). Change it to `import { viewYaml, editYaml } from "@/store/yamlViewer";`.
- Find the existing `View YAML…` ContextMenuItem (search `viewYaml(` in the file). Directly after it add:
  ```tsx
  <ContextMenuItem onClick={() => editYaml("deployment", d.metadata.name, d.metadata.namespace)}>Edit YAML…</ContextMenuItem>
  ```
  (`d` is the deployment in scope — match the variable the adjacent `viewYaml`/`restart(d)` items use. If this row has no `View YAML…` item, place `Edit YAML…` right after the existing `Edit config…` item on line 78.)

- [ ] **Step 4: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/configmaps/ConfigMapsPanel.tsx apps/web/src/panels/secrets/SecretsPanel.tsx apps/web/src/panels/deployments/DeploymentRow.tsx
git commit -m "feat(web): Edit YAML… on Deployments, ConfigMaps, Secrets"
```

- [ ] **Step 6: Manual verification (Docker)**

`docker compose up -d --build`, then: right-click a ConfigMap → **Edit YAML…** → the dialog loads the cleaned manifest (no `status:`/`managedFields`), **Edit** opens the Monaco editor, change a value, **Apply…** opens the ConfirmSheet with the `applyManifest` resource summary, confirm → the change lands. Repeat for a Deployment and a Secret.

---

## Phase 5 — Consumer C: GitOps file editing

### Task 11: Server — read one repo file

**Files:**
- Modify: `apps/server/src/git.ts` (add `readRepoFile`)
- Modify: `apps/server/src/index.ts` (new route + import)

- [ ] **Step 1: Add `readRepoFile` to git.ts**

In `apps/server/src/git.ts`, add this exported function next to `listRepoTree` (it reuses the existing `githubHeaders` and `safeRepoFilePath`):

```ts
/** Read a single file's text from a repo via the GitHub contents API — mirrors
 *  listRepoTree but for one blob. Returns the decoded UTF-8 content. Path is
 *  guarded by safeRepoFilePath (no traversal). */
export async function readRepoFile(
  token: string,
  ownerRepo: string,
  branch: string,
  path: string,
): Promise<{ ok: boolean; content?: string; message?: string }> {
  let rel: string;
  try {
    rel = safeRepoFilePath(path);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return { ok: false, message: "bad repo" };
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${rel}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) return { ok: false, message: `GitHub ${res.status}` };
  const j = (await res.json().catch(() => ({}))) as { content?: string; encoding?: string };
  if (typeof j.content !== "string") return { ok: false, message: "not a file" };
  const decoded = j.encoding === "base64" ? Buffer.from(j.content, "base64").toString("utf8") : j.content;
  return { ok: true, content: decoded };
}
```

(Confirm `safeRepoFilePath` and `githubHeaders` are in scope in `git.ts` — both already exist there; if `safeRepoFilePath` is imported from `@rigel/k8s/src/gitSources`, it already is for `previewRepoFix`.)

- [ ] **Step 2: Add the route**

In `apps/server/src/index.ts`:
- Add `readRepoFile` to the existing `from "./git"` import block (lines ~9–12).
- After the `/api/git/repo-tree` handler (ends ~line 419), add:
```ts
    // GET /api/git/repo-file?repo=owner/repo&branch=&path= — one file's text
    // (server holds the token). Powers the GitOps file editor.
    if (url.pathname === "/api/git/repo-file" && req.method === "GET") {
      const repo = url.searchParams.get("repo");
      const branch = url.searchParams.get("branch");
      const path = url.searchParams.get("path");
      if (!repo || !branch || !path) return Response.json({ error: "missing repo, branch, or path" }, { status: 422 });
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub not connected" }, { status: 409 });
      const r = await readRepoFile(token, repo, branch, path);
      if (!r.ok) return Response.json({ error: r.message ?? "could not read file" }, { status: 422 });
      return Response.json({ content: r.content });
    }
```

- [ ] **Step 3: Verify the server builds**

Run: `pnpm --filter @rigel/server build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/git.ts apps/server/src/index.ts
git commit -m "feat(server): GET /api/git/repo-file — read one repo file"
```

### Task 12: Client — repo-file hook + GitOps file-edit dialog

**Files:**
- Modify: `apps/web/src/panels/gitops/gitApi.ts` (add `useRepoFile`)
- Create: `apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx`

- [ ] **Step 1: Add the repo-file query hook**

In `apps/web/src/panels/gitops/gitApi.ts`, after `useRepoTree` (line ~117), add:

```ts
/** Read one repo file's text (null path = disabled). Server holds the token. */
export function useRepoFile(repo: string, branch: string, path: string | null) {
  return useQuery({
    queryKey: ["repo-file", repo, branch, path],
    queryFn: () =>
      req<{ content: string }>(
        `/api/git/repo-file?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!path,
  });
}
```

- [ ] **Step 2: Create the file-edit dialog**

Create `apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx`:

```tsx
// Edit a YAML file inside a configured GitOps source, then open a PR. Lists the
// source's manifest folder, opens a clicked .yaml file in the Monaco editor, and
// hands the edited content to the existing proposeRepoFix flow (diff preview →
// PR) via the guarded ConfirmSheet. Nothing is applied to the cluster.
import { useEffect, useState } from "react";
import { Folder, FileText } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import { useRepoTree, useRepoFile, type GitSource, type GitDeployment } from "./gitApi";

export function GitOpsFileEditDialog({ repo, dep, onClose }: { repo: GitSource; dep: GitDeployment; onClose: () => void }) {
  const repoFullName = repo.repoURL.replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  const [folder, setFolder] = useState(dep.path || ".");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [proposeAction, setProposeAction] = useState<ActionBlock | null>(null);
  const { data: schema } = useClusterYamlSchema();

  const apiPath = folder === "." ? "" : folder;
  const { data: entries, isLoading } = useRepoTree(repoFullName, repo.branch, apiPath, true);
  const file = useRepoFile(repoFullName, repo.branch, filePath);

  // Seed the editor with the file's content once it loads (and re-seed when the
  // selected file changes). Keyed on filePath so switching files re-seeds.
  useEffect(() => {
    if (file.data?.content !== undefined) setDraft(file.data.content);
  }, [file.data, filePath]);

  const dirs = (entries ?? []).filter((e) => e.type === "dir");
  const yamlFiles = (entries ?? []).filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name));

  function openFile(path: string) {
    setDraft("");
    setFilePath(path);
  }

  function handlePropose() {
    if (!filePath) return;
    setProposeAction({
      kind: "proposeRepoFix",
      source: dep.name,
      filePath,
      content: draft,
      title: `Update ${filePath}`,
      label: `Open PR: Update ${filePath}`,
    });
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-[15px]">{dep.name}</DialogTitle>
            <DialogDescription className="text-xs">
              {repoFullName} · {repo.branch} — edit a manifest and open a PR (nothing is applied).
            </DialogDescription>
          </DialogHeader>

          {!filePath ? (
            <div className="max-h-[60vh] overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              {isLoading && <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>}
              {folder !== "." && (
                <button type="button" onClick={() => setFolder(folder.split("/").slice(0, -1).join("/") || ".")} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} /> ..
                </button>
              )}
              {dirs.map((d) => (
                <button key={d.path} type="button" onClick={() => setFolder(d.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
                  <span className="font-mono">{d.name}/</span>
                </button>
              ))}
              {yamlFiles.map((f) => (
                <button key={f.path} type="button" onClick={() => openFile(f.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
                  <FileText className="size-3.5 shrink-0" style={{ color: "var(--fg-tertiary)" }} />
                  <span className="font-mono">{f.name}</span>
                </button>
              ))}
              {!isLoading && dirs.length === 0 && yamlFiles.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">No YAML files here.</div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">{filePath}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setFilePath(null); setDraft(""); }}>Back</Button>
                  <Button size="sm" onClick={handlePropose} disabled={file.isLoading || draft === ""}>Open PR…</Button>
                </div>
              </div>
              {file.isLoading ? (
                <div className="py-10 text-center text-sm text-muted-foreground">Loading file…</div>
              ) : (
                <div style={{ height: "60vh", borderRadius: 8, overflow: "hidden", border: "1px solid #26272B" }}>
                  <YamlEditor value={draft} onChange={setDraft} schema={schema ?? null} />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmSheet action={proposeAction} open={!!proposeAction} onClose={() => setProposeAction(null)} />
    </>
  );
}
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/gitops/gitApi.ts apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx
git commit -m "feat(web): GitOps file-edit dialog + useRepoFile hook"
```

### Task 13: Mount the dialog from the GitOps source card

**Files:**
- Modify: `apps/web/src/panels/gitops/RepoCard.tsx`

- [ ] **Step 1: Read the card to find where deployments render**

Run: `cat apps/web/src/panels/gitops/RepoCard.tsx`
Identify the props (it receives the `GitSource` — likely as `source`/`s`) and where it maps `source.deployments` into `<DeploymentRow>`s.

- [ ] **Step 2: Add an "Edit files…" affordance + dialog state**

In `apps/web/src/panels/gitops/RepoCard.tsx`:
- Add imports:
  ```tsx
  import { useState } from "react";
  import { GitOpsFileEditDialog } from "./GitOpsFileEditDialog";
  import type { GitDeployment } from "./gitApi";
  ```
  (If `useState` is already imported, don't duplicate it.)
- Add state inside the component: `const [editingDep, setEditingDep] = useState<GitDeployment | null>(null);`
- For each deployment row rendered, add a small button that opens the dialog — e.g. next to the existing per-deployment controls:
  ```tsx
  <Button size="sm" variant="ghost" onClick={() => setEditingDep(dep)}>Edit files…</Button>
  ```
  (Use the loop's deployment variable name — `dep` in `DeploymentRow`, confirm the map variable in this file.)
- Before the component's closing tag, render the dialog (replace `source` with this file's GitSource prop name):
  ```tsx
  {editingDep && <GitOpsFileEditDialog repo={source} dep={editingDep} onClose={() => setEditingDep(null)} />}
  ```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/gitops/RepoCard.tsx
git commit -m "feat(web): launch GitOps file-edit dialog from the source card"
```

- [ ] **Step 5: Manual verification (Docker)**

`docker compose up -d --build`, GitOps panel (requires a connected GitHub source): open a source → **Edit files…** on a deployment → browse to a `.yaml` → it loads in the editor (schema-aware) → edit → **Open PR…** → ConfirmSheet shows the git diff → confirm opens a real PR. (Only run the final "Open PR" against a repo you own / a throwaway branch — this is an outward-facing action.)

---

## Phase 6 — Full verification, docs, tickets

### Task 14: Whole-suite verification

- [ ] **Step 1: Run every suite + typecheck + build**

```bash
pnpm --filter @rigel/k8s test
pnpm --filter @rigel/server build
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter web build
```
Expected: all green.

- [ ] **Step 2: Rebuild the container and smoke-test all three surfaces**

```bash
docker compose up -d --build
```
Walk Apply (upload/type/validate/apply), Edit-live (ConfigMap/Deployment/Secret edit→apply), and GitOps (browse→edit→PR diff). Confirm that with a cluster lacking `/openapi/v2` the editors still load and lint (degraded path), and with schema present an invalid field squiggles.

### Task 15: Update Outline docs + derive Plane tickets

Per the project docs/tickets workflow (Outline = source of truth; derive Plane tickets):

- [ ] **Step 1: Update the Rigel app docs in Outline (Outline MCP)**

Add/update a doc under the Rigel collection describing the YAML editor: the three surfaces, the live-cluster schema source + lint-only degradation, the upload/drag-drop, and that edit/apply still route through the guarded ConfirmSheet. Capture follow-up ideas: extend Edit YAML to the remaining resource panels; manual schema-refresh control; schema staleness on CRD changes.

- [ ] **Step 2: Create Plane tickets from those docs (Plane MCP)**

Derive issues for the deferred items (remaining-panel Edit YAML, schema refresh UI). Note from memory: **no Rigel Plane project exists yet** — create it first (or confirm the right project) before filing.

### Task 16: Finish the branch

- [ ] **Step 1: Invoke the finishing-a-development-branch skill**

Use `superpowers:finishing-a-development-branch` to choose merge/PR/cleanup for `feature/monaco-yaml-editor`.

---

## Self-review notes (author)

- **Spec coverage:** core `<YamlEditor>` (Tasks 4–5) ✓; live-cluster schema + no-fallback degradation (Tasks 1, 3, 5) ✓; Apply + upload (Tasks 6–7) ✓; Edit-live on the representative few (Tasks 8–10) ✓; GitOps files (Tasks 11–13) ✓; lazy-load / bundle concern (Tasks 0, 5 step 4) ✓; testing approach (per-task) ✓; docs/tickets (Task 15) ✓; Docker rebuild verification (Tasks 7/10/13/14) ✓.
- **Schema-shape risk:** the converter ships a concrete `oneOf`+const implementation with unit tests; Task 7 step 4 is the first end-to-end browser check. If `oneOf` discrimination proves weak on the real cluster doc, adjust the converter (the test asserts structure, not monaco internals) — this is the one spot that may need iteration.
- **GitOps UI unknowns (RepoCard internals):** Task 13 step 1 reads the file before editing so the wiring (prop name, deployment map variable) is grounded against the real file rather than guessed. The editor draft is seeded with a clean `useEffect` (Task 12), avoiding any setState-in-render.
