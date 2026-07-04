# Agent Channel-Triggered Audits — Implementation Plan

> Small feature; steps use `- [ ]`. Spec: `docs/superpowers/specs/2026-07-04-agent-channel-audits-design.md`.

**Goal:** The agent's free-text diagnose model can run the deterministic `rigel-audit` CLI when an operator asks for an audit over Signal/Matrix.

---

## Task 1: audit-cli build resolves `@rigel/k8s` by source (for the agent's npm Docker build)

**File:** `packages/audit-cli/tsconfig.json`

- [ ] Add `baseUrl: "."` and `paths`:
  ```json
  "paths": {
    "@rigel/k8s": ["../k8s/src/index.ts"],
    "@rigel/k8s/src/*": ["../k8s/src/*"]
  }
  ```
  (additive to the existing `compilerOptions`).
- [ ] Verify nothing regresses: `pnpm --filter @rigel/audit-cli typecheck && pnpm --filter @rigel/audit-cli test && pnpm --filter @rigel/audit-cli build` all green (the built `dist/rigel-audit.mjs` still runs `--help`).
- [ ] Commit: `chore(audit-cli): resolve @rigel/k8s via tsconfig paths for source bundling`.

## Task 2: diagnose model gains the audit CLI

**File:** `agent/src/diagnose.ts` (+ `diagnose.test.ts`)

- [ ] Add `"Bash(rigel-audit *)"` to the `READ_ONLY_TOOLS` array.
- [ ] Extend `SYSTEM_PROMPT` with a paragraph:
  > "If the operator asks for a reliability, security, or performance audit, run `rigel-audit <kind> --json` (pipe through `jq` to summarize on a large cluster), then report the findings grouped by severity — critical first — concisely for a phone. NEVER invent CPU or memory request/limit numbers: size a fix only from a finding's `evidence`; if a finding has no evidence, say a metrics backend is needed. Don't re-run detection or invent findings beyond the CLI output."
- [ ] Test (`diagnose.test.ts`, new if absent): import `READ_ONLY_TOOLS` (export it if not already) and assert it includes `"Bash(rigel-audit *)"` and the six kubectl reads. Run `pnpm --filter <agent pkg> test diagnose` (check `agent/package.json` for the vitest command).
- [ ] Commit: `feat(agent): let the diagnose model run the rigel-audit CLI (HELM-20)`.

## Task 3: RBAC — read PDBs + HPAs

**File:** `packages/k8s/src/assistant.ts` (`rigel-assistant` ClusterRole, ~line 446) + `assistant.test.ts`

- [ ] Add two rules to the ClusterRole `rules:` list:
  ```yaml
  - apiGroups: ["policy"]
    resources: [poddisruptionbudgets]
    verbs: [get, list, watch]
  - apiGroups: ["autoscaling"]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch]
  ```
- [ ] Extend the existing rbac test in `assistant.test.ts` to assert the rendered ClusterRole YAML contains `poddisruptionbudgets` and `horizontalpodautoscalers`.
- [ ] Verify: `pnpm --filter @rigel/k8s test assistant && pnpm --filter @rigel/k8s typecheck`.
- [ ] Commit: `feat(k8s): grant the assistant PDB + HPA reads for audits (HELM-20)`.

## Task 4: bundle rigel-audit into the agent image

**File:** `agent/Dockerfile` (NOT unit-verifiable — dev machine has no Docker; verified when CI builds the image)

- [ ] **Build stage** (after the `COPY packages/k8s/src ...` line): add
  ```dockerfile
  COPY packages/audit-cli/package.json packages/audit-cli/tsconfig.json ./packages/audit-cli/
  COPY packages/audit-cli/src ./packages/audit-cli/src
  ```
  and after `RUN npm run build` (agent build, which installs esbuild), add:
  ```dockerfile
  RUN npx esbuild ../packages/audit-cli/src/index.ts --bundle --platform=node \
        --format=esm --tsconfig=../packages/audit-cli/tsconfig.json \
        --outfile=/app/packages/audit-cli/dist/rigel-audit.mjs
  ```
  (run from `/app/agent`, where esbuild is installed; `..` reaches the sibling package. The tsconfig `paths` from Task 1 resolve `@rigel/k8s` to `../k8s/src`.)
- [ ] **Runtime stage** (after the agent `dist` COPY): add
  ```dockerfile
  COPY --from=build /app/packages/audit-cli/dist/rigel-audit.mjs /usr/local/bin/rigel-audit.mjs
  RUN printf '#!/bin/sh\nexec node /usr/local/bin/rigel-audit.mjs "$@"\n' > /usr/local/bin/rigel-audit \
   && chmod +x /usr/local/bin/rigel-audit
  ```
  (place these BEFORE the `USER node` line so the chmod/writes run as root.)
- [ ] Commit: `feat(agent): bundle the rigel-audit CLI into the agent image (HELM-20)`.

## Verification

- Automated: audit-cli (Task 1), agent diagnose test (Task 2), k8s assistant rbac test (Task 3) all green; `pnpm --filter @rigel/k8s test`, `pnpm --filter web typecheck` unaffected.
- Manual/live (after the agent image is rebuilt + rolled out): message the agent "run a security audit" on Signal/Matrix → expect a severity-grouped findings reply. Confirm the agent pod can `kubectl get poddisruptionbudgets,horizontalpodautoscalers` (RBAC) — a reliability/performance audit will error on those reads otherwise.
