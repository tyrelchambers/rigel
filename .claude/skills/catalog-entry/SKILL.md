---
name: catalog-entry
description: Use when adding a new app to the Helmsman catalog (catalog.json) or auditing existing entries for install accuracy. Dispatches research subagents (general-info, system-requirements, install-method, render) and verifies install correctness against live tooling (helm/docker/kubectl) via scripts/verify-catalog-entry.sh before writing. Triggers on "add <app> to the catalog", "audit the catalog", "verify <app>'s install instructions".
---

# Catalog Entry — research, verify, write

Produces and verifies Helmsman catalog entries (`packages/catalog/catalog.json`).
Design: `docs/superpowers/specs/2026-06-02-catalog-entry-automation-design.md`.

**Core principle:** generation is fuzzy (subagents, on the user's subscription — never
`claude -p`); verification is hard truth (the deterministic shell harness). An entry is
written ONLY when every live check passes. Do this work ONCE, here, and **bake** the
verified, parameterized artifact + typed secret schema into the entry (Step 6) so the
in-app install is deterministic — it never re-runs an LLM or scrapes generated YAML.

## Entry points

- `add <app name | url>` — research from scratch → synthesize → verify → **bake** → write a
  new entry. Refuse if the `id` already exists (suggest `audit` instead).
- `audit <app id>` — re-verify one existing entry; auto-fix if the correction verifies,
  else report.
- `audit all` — sweep every entry, ONE app at a time. Warn about time/token cost first and
  get a go-ahead before starting. End with a summary table.

## Preconditions (check once, up front)

`helm`, `docker`, `kubectl`, `python3` must be on PATH. If any is missing, STOP and say so —
do not silently downgrade to research-only. A cluster is optional (the harness falls back to
client-side dry-run and reports what it skipped).

## Pipeline (the `add` flow; `audit` reuses it on failure)

### 1. Research — dispatch in parallel (Agent tool, structured output)
Run these three concurrently in one message. Each returns JSON only.

- **general-info** → `name`, `tagline` (≤ ~60 chars), `description` (2–3 sentences),
  `category` (EXACTLY one of: `database`, `observability`, `productivity`, `dev-tools`,
  `media`, `network`, `other`), `iconSystemName` (a real SF Symbol), `docsURL` (required),
  `repoURL`, `homepageURL`, `tags[]`, `matchImages[]` (container refs used to detect an
  existing install), `persistence` (bool), `exposesIngress` (bool), `notes` (gotchas:
  license, mandatory external auth, resource weight).
- **system-requirements** → `cpuRequest`, `cpuLimit`, `memoryRequest`, `memoryLimit`,
  `storageGiB`, sized for a single homelab instance, with a one-line rationale from official
  requirements docs / chart resource defaults.
- **install-method** → `mode` (`helm` | `manifest`).
  - helm: `repoName`, `repoURL`, `chart`, `version` (only if pinning).
  - manifest: workload shape (images, ports, env, secrets, PVCs) AND, for each image, what
    it believes the `Entrypoint`/`Cmd` are. (Re-checked by the harness regardless.)

### 2. Synthesize the draft entry (you, the main agent)
Merge the three results into a `CatalogApp` object matching the schema in
`packages/catalog/src/types.ts`:
`id, name, tagline, description, category, iconSystemName, docsURL, repoURL, homepageURL,
tags, matchImages, requirements{cpuRequest,cpuLimit,memoryRequest,memoryLimit,storageGiB},
persistence, exposesIngress, notes, installPromptTemplate, install?`.

Author `installPromptTemplate` in the house style already in `catalog.json` (sections:
App / Target / Conventions / Output). Use these template variables (the wizard substitutes
them): `{{instance}} {{namespace}} {{hostname}} {{nodeName}} {{storage}} {{notes}}
{{clusterIssuer}} {{redirectMiddleware}} {{imagePullSecret}}`.
- **helm apps:** the Output section says reply with ONE ```yaml values block (+ a ```secrets
  block if needed); do NOT emit helm commands or apiVersion/kind resources.
- **manifest apps:** ONE ```yaml multi-document manifest, placeholder Secret first, secrets
  as `<FILL_ME_IN>`.
- **Entrypoint discipline (the command-vs-args trap):** only set a container `command:` when
  its first element is a REAL on-PATH binary. If the image entrypoint wraps a launcher (e.g.
  `dumb-init -- ak`, `docker-entrypoint.sh`), pass the subcommand via `args:` (authentik →
  `args:["server"]` → `ak server`) or name the real binary first (minio →
  `command:["minio","server",...]`). See `[[project_catalog_command_args_trap]]`.

### 3. Render the sample artifact — dispatch the **render** subagent
Fill sample values into the `installPromptTemplate` and hand the render agent the SAME
preamble + filled template the wizard sends; it returns the generated YAML as structured
output. No `claude -p`.
Sample vars: `instance=acme`, `namespace=default`, `hostname=acme.example.com`,
`nodeName=""`, `storage=<from requirements>`, `notes="(none)"`,
`clusterIssuer=letsencrypt-prod`, `redirectMiddleware=default-redirect-https@kubernetescrd`,
`imagePullSecret=""`.

### 4. Verify — run the deterministic harness
`scripts/verify-catalog-entry.sh` (see its `--help`). Write the rendered YAML to a temp file.

- **helm app:**
  - `verify-catalog-entry.sh helm-chart --repo-name N --repo-url U --chart C [--version V]`
  - `verify-catalog-entry.sh helm-render --repo-name N --repo-url U --chart C [--version V] --values <rendered.yaml> --namespace default`
- **manifest app:**
  - `verify-catalog-entry.sh manifest-validate --file <rendered.yaml> --namespace default`
- **both — image + entrypoint capture:**
  - `verify-catalog-entry.sh image <img> [<img> ...]` for every image in the rendered YAML
    (and `matchImages`). This proves the images exist and prints their `Entrypoint`/`Cmd`.

**Entrypoint lint (your judgment, using the captured Entrypoint/Cmd):** for every container
in the rendered manifest that sets `command:`, confirm `command[0]` is real — i.e. it is an
absolute path, OR a shell (`sh`/`bash`), OR it matches the image's `Cmd[0]` / appears in its
`Entrypoint`. If `command[0]` is a bare subcommand and the image has a launcher Entrypoint
(or a different `Cmd`), it's the trap — FAIL and fix (switch to `args:`, or prepend the real
binary). Helm values can't be linted this way; rely on `helm-render` + the chart's own
schema.

### 5. Write (auto, only on all-green) or retry
- **All checks pass →** insert the entry into `catalog.json` with a SURGICAL string insert
  that preserves the file's existing formatting (do NOT `json.load`/`json.dump` the whole
  file — that reformats unrelated entries; insert the new object text before the closing
  `]`). Then run `pnpm --filter @rigel/catalog test` to confirm the bundled catalog
  still decodes. Report what each check returned.
- **Any check fails →** re-dispatch ONLY the relevant research agent with the failure text
  as feedback (e.g. "helm show chart failed: chart not found" → install-method;
  "entrypoint lint: command[0]=server but Entrypoint is dumb-init -- ak" → install-method +
  re-synthesize the template). Max 2 retries per dimension. Still failing → STOP and surface
  the evidence. NEVER write an unverified entry.

### 6. Bake the verified artifact into the entry (deterministic install)
The whole point of this skill is to do the research + render + verify ONCE, here, so the
in-app install never re-runs an LLM or scrapes generated YAML. So **persist** the artifact:

- **Parameterize, don't hard-code.** The render in Step 3 used sample values to verify;
  the *baked* artifact must keep the wizard's template variables (`{{instance}}`,
  `{{namespace}}`, `{{hostname}}`, `{{nodeName}}`, `{{storage}}`, `{{clusterIssuer}}`,
  `{{redirectMiddleware}}`, `{{imagePullSecret}}`) as literal `{{…}}` tokens. Put EVERY
  user/secret value into the leading `Secret`'s `stringData` as `KEY: <FILL_ME_IN>` and
  reference it from workloads via `secretKeyRef` (never inline a secret as a plain-env
  `value: <FILL_ME_IN>` — the wizard keys substitution off the YAML key, so a bare
  `value:` line both mis-keys and reintroduces the old scrape bug).
- **Declare the secret schema** as `install.secrets[]` — one `SecretFieldSpec` per key:
  `kind: random` for app-generated values (passwords, signing keys) with a `length` and,
  when the app validates the encoding, a `format` (`hex` for things documented as
  `openssl rand -hex N`); `kind: user` for values only the operator has (OIDC client
  id/secret + endpoint URLs, admin email, external API keys). `label`, optional
  `description`, `required` (default true). The schema — NOT a YAML scrape — is the
  authoritative field list the Secrets step renders.
- **Write** `install.mode` + `install.manifest` (manifest mode) or `install.values` (helm
  mode) + `install.secrets` into the entry with the same SURGICAL string insert. Keep
  `installPromptTemplate` as the legacy fallback.
- **Verify the baked form** before writing: substitute sample `{{vars}}` + dummy secret
  values, assert no `<FILL_ME_IN>`/`{{` survive, then run the Step-4 harness on the result
  (`manifest-validate` / `helm-render` + `image`). Then `pnpm --filter @rigel/catalog test`.
- An entry with a baked artifact is `isBaked` — the wizard installs it deterministically
  (substitute + apply, no Claude). Migrate apps to baked one at a time; `outline` is the
  reference example.

## Audit flow

For each target entry: run install-method (light, against the current entry) + render +
harness. If it verifies, mark ✓ and move on. If it fails, run the full pipeline to produce a
correction; auto-write if the correction verifies (✏️), else add to the report (⚠️ needs
user). For `audit all`, iterate one app at a time and finish with a table:

```
app            result    note
authentik      ✏️ fixed   command:["server"] → args:["server"] (entrypoint dumb-init -- ak)
harbor         ✓          chart harbor/harbor renders; images exist
outline        ⚠️ check   image outlinewiki/outline:latest ok; dry-run needs a cluster
```

## Notes
- Helm app correctness is bounded by `helm-render` against the real chart; a values typo the
  chart tolerates won't be caught. Say so rather than implying total coverage.
- If no cluster is reachable, `manifest-validate` reports server-side dry-run as SKIPPED —
  carry that ⚠️ into the summary; don't claim full verification.
