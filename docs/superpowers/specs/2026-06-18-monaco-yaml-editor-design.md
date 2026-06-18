# Monaco YAML editor — Apply / Edit-live / GitOps

**Date:** 2026-06-18
**Status:** Approved (design)
**Branch:** master (current)

## Problem

The only YAML-editing surface today is the **Apply YAML** panel
(`apps/web/src/panels/apply/ApplyYamlPanel.tsx`): a plain `<textarea>` where you
paste a manifest, hit **Validate** (server `kubectl apply --dry-run=server`),
then **Apply** through the guarded `ConfirmSheet`. It has no syntax
highlighting, no in-editor validation, no autocomplete, and no way to load a
file. There is also **no "edit a live resource's YAML"** capability anywhere (no
`kubectl edit` equivalent), and the GitOps flow can open a PR from edited
content but has no editor to produce that content.

We want a real code editor — Monaco — so users can highlight, autocomplete,
validate, type, **and upload** YAML across three surfaces: Apply, live-resource
edit, and GitOps repo files.

## Goal & non-goals

**Goal:** one reusable Monaco-based `<YamlEditor>` with Kubernetes
schema-awareness, mounted in three places, each reusing the existing guarded
apply / PR plumbing.

**Non-goals (YAGNI):**
- No new mutation paths. Apply and live-edit both go through the existing
  `applyManifest` action + `ConfirmSheet`. GitOps goes through the existing
  `previewRepoFix` / `proposeRepoFix`.
- No static bundled schema. No offline schema. No multi-file tabs / explorer.
- Not wiring Edit-YAML into *every* panel in this pass (see Consumer B scope).

## Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Editor library | **Monaco + `monaco-yaml`** (yaml-language-server engine — same as VS Code's k8s YAML), lazy-loaded |
| Editor intelligence | **Full: Kubernetes schema awareness** (autocomplete + inline errors), on top of syntax + YAML lint |
| Schema source | **Live cluster OpenAPI** (apiserver), cached per context |
| Schema failure behavior | **Degrade to YAML-lint only** — never fall back to stale/static schema |
| Scope | All three surfaces: Apply, Edit-live, GitOps files |
| Edit-live first cut | **Representative few:** Deployments, ConfigMaps, Secrets |

## Architecture

One shared component, three mount points, a schema pipeline behind them:

```
                         ┌──────────────────────────────┐
   GET /api/openapi-schema ─▶ server: kubectl get --raw  │
   (cached per context)     │ /openapi/v2 → JSON Schema  │
                            └──────────────┬─────────────┘
                                           │ (schema, or null on failure)
                                           ▼
   ┌────────────┐   ┌────────────┐   ┌───────────────┐
   │ Apply panel│   │ Edit-live  │   │ GitOps file   │   mount points
   └─────┬──────┘   └─────┬──────┘   └──────┬────────┘
         └───────────┬────┴─────────────────┘
                     ▼
            <YamlEditor>  (Monaco + monaco-yaml, lazy, themed)
                     │
   Apply ──▶ applyManifest action ──▶ ConfirmSheet (existing)
   GitOps ─▶ previewRepoFix / proposeRepoFix (existing)
```

### 1. Core: `<YamlEditor>` component

`apps/web/src/components/YamlEditor.tsx` — the one reusable piece.

- Wraps `@monaco-editor/react` + `monaco-yaml`. Use the **latest** published
  versions of both.
- **Lazy-loaded** via `React.lazy` + dynamic `import()` so Monaco's bundle and
  its web workers fetch only when a YAML surface first opens — the initial app
  bundle (and every non-YAML panel) is unaffected.
- **Vite worker wiring:** Monaco needs its `editor` worker and `monaco-yaml`'s
  `yaml` worker registered via `self.MonacoEnvironment.getWorker` using Vite
  `?worker` imports (a small `monacoWorkers.ts` setup module). This is the known
  Monaco-under-Vite integration wrinkle; the plan carries it as an explicit
  step.
- **Props (minimal, focused):** `value: string`, `onChange(next: string)`,
  `readOnly?: boolean`, `schema?: ResolvedSchema | null`, fill-height layout.
  The component does *one* thing: "a themed YAML editor that optionally knows the
  cluster schema." It owns no apply/PR logic — consumers wire that.
- **Theme & UX:** match the existing editor look already in the panel
  (`#08080A` background, `Geist Mono`, the current colors). Minimap off,
  line numbers, find/replace, bracket + indent guides, `tabSize: 2`,
  multi-document (`---`) aware.

### 2. Schema pipeline (live cluster OpenAPI)

- **New server read:** `GET /api/openapi-schema` (one endpoint; folds into the
  existing one-shot read style, not a sprawl of variants). It runs
  `kubectl get --raw /openapi/v2`, converts the result into the JSON-Schema
  shape `monaco-yaml` expects, and returns it. Conversion must support
  **per-document matching by `apiVersion` + `kind`** so each `---` doc in a
  multi-doc manifest validates against the right definition — including the
  cluster's **CRDs** (Cert-Manager `Certificate`, etc.), exactly at the
  cluster's version.
- **Caching:** in-memory, keyed by context. CRDs/version change rarely; provide
  a manual refresh (re-fetch). No persistence needed.
- **Client wiring:** `monaco-yaml`'s `setDiagnosticsOptions({ schemas, … })`
  consumes the schema; the component receives it via the `schema` prop and is
  agnostic to where it came from.
- **No fallback (per project rule):** if the fetch or conversion fails, the
  editor runs **YAML-lint only** (syntax + structural lint, no k8s schema) and
  shows a subtle "schema unavailable" note. It must **never** serve a stale or
  static schema — that would give false confidence.
- ⚠️ **Main technical risk — the OpenAPI-v2 → per-kind JSON-Schema conversion.**
  This is the live equivalent of what `yannh/kubernetes-json-schema` does
  offline (Swagger definitions → per-`GroupVersionKind` schemas with `$ref`
  flattening / `x-kubernetes-group-version-kind` mapping). The implementation
  plan **must begin with a small spike** that produces a working schema for one
  core kind (e.g. `Deployment`) and one CRD before the consumers are wired.

### 3. Consumer A — Apply YAML panel

Swap the `<textarea>` in `ApplyYamlPanel.tsx` for `<YamlEditor>`. Additions:

- **Upload:** an *Upload* button **and** drag-and-drop of `.yaml` / `.yml`
  files onto the editor — browser `FileReader`, content loaded into the editor
  value. No server round-trip.
- **Validate** (server dry-run) and **Apply** (`ConfirmSheet`) stay exactly as
  they are. The editor's inline schema validation is **additive**, never a
  replacement for the authoritative server dry-run. The post-validate resource
  summary list stays.

### 4. Consumer B — Edit a live resource (new)

A single **shared "Edit YAML" action** component, wired this pass into
**Deployments, ConfigMaps, Secrets** (one workload, one config, one secret —
proves the pattern; remaining panels are trivial drop-ins later).

- **Server read:** extend the resource read to return the live manifest as YAML
  (`kubectl get <kind> <name> -n <ns> -o yaml`), **lightly cleaned** like
  `kubectl edit` — strip `status` and `metadata.managedFields` (keep the rest).
  Prefer extending the existing read with a format/filter parameter over adding
  a parallel fetch method.
- **Flow:** open the cleaned manifest in `<YamlEditor>` → edit → **Apply through
  the existing `applyManifest` action + `ConfirmSheet`** (apply handles
  updates). **No new mutation path**, and the exact `kubectl` command is shown
  before it runs, same as every other mutation.

### 5. Consumer C — GitOps file edit (new)

The write side already exists: `RepoFixInput` is `{ source, token, filePath,
content, title, body? }`; `previewRepoFix` returns a diff and `proposeRepoFix`
opens the PR. The **only gap** is reading the existing file into the editor —
`listRepoTree` lists the tree but returns no file contents.

- **Server:** add one focused `readRepoFile(...)` in `apps/server/src/git.ts`
  that reuses `ensureCheckout` then reads the requested file (guarded by the
  existing `safeRepoFilePath`). Reading one file's content is a distinct purpose
  from listing the tree, so a new small function is appropriate — but it reuses
  the checkout machinery rather than re-cloning.
- **Flow:** load file content into `<YamlEditor>` → edit → `previewRepoFix`
  (show the diff) → `proposeRepoFix` (open the PR). Both already accept
  `{ filePath, content }`.

## Build order

1. **Schema spike** — `/api/openapi-schema` + conversion proving one core kind +
   one CRD validate in a throwaway editor.
2. **Core `<YamlEditor>`** — Monaco + monaco-yaml, lazy-load, Vite workers,
   theme, schema prop, lint-only degradation.
3. **Consumer A — Apply** (smallest; reuses all existing apply plumbing) +
   upload / drag-drop.
4. **Consumer B — Edit-live** — shared action + server manifest-as-YAML read;
   Deployments, ConfigMaps, Secrets.
5. **Consumer C — GitOps** — `readRepoFile` + editor wired into the PR flow.

## Testing

- **Schema conversion** (server, bun test): given a captured `/openapi/v2`
  fixture, the converter emits a schema that matches a core kind and a CRD by
  `apiVersion`+`kind`; malformed input yields `null` (→ lint-only), not a throw.
- **`<YamlEditor>`** (vitest + Testing Library): renders, surfaces value
  changes via `onChange`, honors `readOnly`, degrades gracefully when
  `schema` is `null`. (Monaco itself is mocked/lazy — assert the wiring, not
  Monaco's internals.)
- **Apply panel:** upload + drag-drop populate the editor; Validate/Apply still
  call the existing endpoints unchanged.
- **Edit-live:** server returns cleaned YAML (no `status` / `managedFields`);
  Apply routes through `applyManifest` + `ConfirmSheet`.
- **GitOps:** `readRepoFile` returns content for a checked-out file and is
  rejected for unsafe paths; edited content reaches `previewRepoFix` /
  `proposeRepoFix`.
- Per project rule: **do not** execute mutation/PR endpoints against the live
  cluster or real repos to "verify wiring" — assert via the command/request
  builders and reads.

## Risks & open notes

- **Bundle weight** — mitigated by lazy-loading Monaco + workers; verify the
  non-YAML initial bundle is unchanged.
- **Schema conversion fidelity** (the spike) — the principal risk; gated first.
- **Docker rebuild** — web changes only appear in the running container after
  `docker compose up -d --build`; bundle/worker changes especially need it.
- **Docs/tickets** — per workflow: update the app's Outline docs and derive
  Plane tickets once this lands.
