# Catalog Entry Automation — Design

**Date:** 2026-06-02
**Status:** Approved design, pending implementation plan

## Problem

The self-hosted app catalog (`Sources/Rigel/Resources/catalog.json`, 53 entries) is
hand-authored. Each entry carries general info, system requirements, and an install
descriptor + `installPromptTemplate` that the in-app wizard feeds to Claude to generate
the install manifest/values at install time.

Hand-authoring from web research alone has shipped incorrect install instructions — e.g.
the Authentik and MinIO templates set `command: ["server"]`, which clobbers the image
`ENTRYPOINT` and crashes the pod with `exec: "server": executable file not found in
$PATH`. These bugs only surfaced from a live install failure and a real `docker inspect`.

We need a structured, repeatable way to **research, generate, and verify** install
instructions for every catalog app — for both newly added apps and the existing 53 —
that grounds correctness in live tooling, not just LLM judgment.

## Goals

- Given an app, produce a complete, schema-valid `catalog.json` entry.
- Prove install correctness against **live tooling** (`helm`, `docker`, `kubectl`), not
  only documentation research.
- Catch the `command`-vs-`args` entrypoint trap specifically.
- Auto-write entries when every verification check passes; stop for the user only on
  failure or ambiguity.
- Cover both adding new apps and auditing existing ones, sharing one research/verify engine.

## Non-goals (YAGNI)

- No live install smoke test (installing into a throwaway namespace and waiting for
  Ready). Render + server-side dry-run is the confidence ceiling for v1.
- No CI integration. This is a developer-invoked skill, run locally where `helm`/`docker`/
  `kubectl` and a cluster are available.
- No UI. This is a dev-time tool, not an in-app feature.
- No automatic batch sweep on a schedule.

## Shape & deliverables

One in-repo Claude Code skill plus one helper script, committed with the catalog so they
version together:

- `.claude/skills/catalog-entry/SKILL.md` — the orchestration skill.
- `scripts/verify-catalog-entry.sh` — the deterministic verification harness (pure shell;
  no LLM). Reusable and independently runnable.

### Entry points

- `add <app name | url>` — research from scratch, synthesize a new entry, verify, and
  (on pass) insert it.
- `audit <app id>` — re-verify one existing entry; auto-fix if the correction verifies,
  else report.
- `audit all` — must be typed explicitly; warns about time/token cost before running the
  full 53-entry sweep one app at a time.

## Architecture

```
add <app>                     audit <app id>
    │                              │
    ▼                              ▼
┌─────────────────── research (in-session subagents, user subscription) ──────────────┐
│  general-info agent   │   system-requirements agent   │   install-method agent       │
└──────────────────────────────────────────────────────────────────────────────────────┘
    │ (3 structured JSON results merged)
    ▼
synthesize draft CatalogApp entry + installPromptTemplate   (main agent)
    │
    ▼
render subagent  →  sample YAML (fills template vars, mimics the wizard's Claude)
    │
    ▼
┌──────────── verify-catalog-entry.sh  (deterministic shell; the "absolutely sure" core) ┐
│ 1. coordinates exist   2. render validates   3. shape valid   4. entrypoint lint        │
└──────────────────────────────────────────────────────────────────────────────────────┘
    │
    ├─ all green ──► surgical insert into catalog.json ──► swift test --filter CatalogStoreTests
    │
    └─ any fail ──► re-dispatch the relevant research agent with the failure as feedback
                    (max 2 retries) ──► still failing? stop and surface to the user
```

Separation of concerns: **generation is fuzzy** (in-session subagents on the user's
subscription — no `claude -p`), **verification is hard truth** (deterministic shell).

## The four dispatched agents

All run in-session via the Agent tool and return structured JSON (no `claude -p`).

### 1. general-info agent
Returns:
- `name`, `tagline` (≤ ~60 chars), `description` (2–3 sentences)
- `category` — exactly one of: `database`, `observability`, `productivity`, `dev-tools`,
  `media`, `network`, `other`
- `iconSystemName` — a real SF Symbol
- `docsURL` (required), `repoURL`, `homepageURL`
- `tags[]`
- `matchImages[]` — container image refs used to detect an existing install
- `persistence` (bool), `exposesIngress` (bool)
- `notes` — gotchas worth surfacing (license, auth requirements, resource weight)

### 2. system-requirements agent
Returns `cpuRequest`, `cpuLimit`, `memoryRequest`, `memoryLimit`, `storageGiB`, sized for a
single homelab instance, with a short rationale sourced from official requirements docs and
chart resource defaults.

### 3. install-method agent
Returns `mode` (`helm` | `manifest`):
- **helm**: `repoName`, `repoURL`, `chart`, `version` (if pinned).
- **manifest**: workload shape — images, ports, env, secrets, PVCs — **and the verified
  image `Entrypoint`/`Cmd`** for each image, so the synthesized template uses `args` vs
  `command` correctly.

This agent may itself run `helm show` / `docker inspect` while researching, but its claims
are re-checked by the deterministic harness regardless.

### 4. render agent
Given the final preamble + filled-in `installPromptTemplate` (the exact text the wizard
would send), returns the generated YAML as structured output — a faithful "what the wizard
will produce" render. No `claude -p`; this is a normal in-session subagent.

## Verification harness — `scripts/verify-catalog-entry.sh`

Pure shell, deterministic, independently runnable. Takes the candidate entry (mode + chart
coords or images) and the rendered sample YAML. Runs:

1. **Coordinates exist**
   - helm: `helm repo add <repoName> <repoURL>` (idempotent) + `helm show chart
     <repoName>/<chart> [--version <v>]` exits 0.
   - manifest: `docker buildx imagetools inspect <image> --format '{{json .Image}}'` for
     each image — proves it exists, captures `Entrypoint`/`Cmd`.
2. **Render validates**
   - helm: `helm template <release> <repoName>/<chart> [--version] -f <values.yaml> -n
     <ns>` exits 0 and emits ≥1 resource.
   - manifest: `kubectl apply --dry-run=server -f <manifest.yaml>` exits 0.
3. **Shape valid** (manifest mode) — reuse the in-app `ManifestShape` validation rules so
   the entry can't ship non-Kubernetes YAML.
4. **Entrypoint lint** (the trap `--dry-run` cannot catch) — for every container in the
   rendered manifest that sets `command:`, cross-check `command[0]` against the image's
   real `Entrypoint`/`Cmd`. Flag anything that would `exec: not found` (a subcommand used
   as a binary). This is the specific guard for the Authentik/MinIO class of bug.

Exit nonzero with a structured reason on the first failed check.

### Sample template variables (render step)
Mirror the wizard's `templateVars`: `instance=acme`, `namespace=default`,
`hostname=acme.example.com`, `nodeName=""`, `storage=<from requirements agent>`,
`notes="(none)"`, `clusterIssuer=letsencrypt-prod`, `redirectMiddleware` = the cluster's
default redirect-https middleware. `imagePullSecret` left empty (public images).

## Synthesis & schema mapping

The main agent merges the three research results into a `CatalogApp` JSON object matching
the Swift schema (`id, name, tagline, description, category, iconSystemName, docsURL,
repoURL, homepageURL, tags, matchImages, requirements, persistence, exposesIngress, notes,
installPromptTemplate, install?`). It authors the `installPromptTemplate` from the
install-method agent's facts, following the established template style already in
`catalog.json` (Target / Conventions / Output sections), with explicit `args`-vs-`command`
guidance baked in for any image whose entrypoint wraps a launcher.

## Write & decode check

On all-green: insert the entry into `catalog.json` with a **surgical string insert** that
preserves the file's existing formatting (do not re-serialize the whole file — that
reformats unrelated entries). Then run `swift test --filter CatalogStoreTests`, which loads
the real bundled catalog through the Swift model, to confirm the catalog still decodes
cleanly.

## Retry loop

A failed check re-dispatches only the relevant research agent with the failure text as
feedback (e.g. "helm show chart failed: chart not found at repo X" → install-method agent;
"entrypoint lint: command[0]=server not in image, Entrypoint is dumb-init -- /lifecycle/ak"
→ install-method agent + re-synthesize template). Max 2 retries per dimension; if still
failing, stop and surface the evidence to the user. Never write an unverified entry.

## Audit mode

For each target entry:
1. Run the install-method agent + render + harness against the **current** entry.
2. Verifies → leave unchanged, mark ✓.
3. Fails → run the full add pipeline to produce a correction; if the correction verifies,
   auto-write it (✏️), else add to the report (⚠️ needs user).

`audit all` iterates one app at a time and ends with a summary table (✓ verified / ✏️ fixed
/ ⚠️ needs you), after warning about cost up front.

## Error handling

- Missing tool (`helm`/`docker`/`kubectl` not on PATH) → stop with a clear message; do not
  silently downgrade to research-only.
- No cluster reachable → server-side dry-run unavailable; report which checks were skipped
  rather than claiming success (no silent caps).
- Ambiguous research (e.g. multiple plausible charts) → stop and ask the user; do not guess.

## Testing

- `scripts/verify-catalog-entry.sh` is runnable standalone against a known-good entry
  (e.g. an existing helm app) and a known-bad one (Authentik with `command:`) as a sanity
  fixture — green on good, red with the right reason on bad.
- The write path is covered by the existing `CatalogStoreTests` bundled-decode test.
