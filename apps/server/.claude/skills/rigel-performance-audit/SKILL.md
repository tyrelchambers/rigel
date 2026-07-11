---
name: rigel-performance-audit
description: Run a deterministic Performance audit of the cluster's workloads and present the findings with evidence-based fixes. Use when the user asks to run a performance audit or check performance/capacity issues (missing memory limits, missing autoscaling, CPU throttling, memory pressure). Metrics-based checks require a Prometheus/VictoriaMetrics backend.
allowed-tools: Bash(rigel-audit *), Bash(kubectl get *)
---

# Performance audit

You are running Rigel's Performance audit. Detection is deterministic. It is
**hybrid**: spec-based checks (missing memory limit, missing autoscaling) always
run; metrics-based checks (CPU throttling, memory pressure) run only when a
metrics backend is present, and those findings carry observed-usage `evidence`.

## Steps

1. Run the audit CLI. Pass `--namespace` when the user named one or the
   conversation is clearly focused on a single namespace; otherwise audit
   cluster-wide. Pass `--context` only when the user named a cluster (the CLI
   otherwise uses the active context):

   ```
   rigel-audit performance --json
   ```

   It prints `{ "audit": "performance", "findings": [...], "counts": {...},
   "metricsBackend": {...} }`. Each finding has `type`, `severity`, `kind`,
   `namespace`, `name`, optional `container`, `rationale`, `fix`, and — for
   resource findings when a metrics backend was available — an `evidence` object:
   `cpuPeak` and `cpuLimit` are in **cores**, `memPeak` and `memLimit` are in
   **bytes**, `hoursCovered` is the metrics window.

   If the CLI exits non-zero, relay its stderr message verbatim and stop. Do not
   retry with different flags, do not produce findings of your own, and do not
   work around a plan-gate message.

2. Open with a one-line summary derived from `counts`. Read `metricsBackend`: if
   `used` is false, say so up front — the spec checks still ran, but CPU
   throttling / memory pressure could not be evaluated. If `used` is true, mention
   the backend (`flavor` in `namespace`) so the user knows where the evidence came
   from. If `findings` is empty, say the audit passed and list what was checked,
   then stop.

   Otherwise present the findings grouped by each finding's `severity` field
   (warning, then info); omit empty groups. Within a group, order by `type`, then
   `namespace/name`. Name the workload and explain each in one plain sentence.
   Every finding must appear individually or inside a counted rollup line — never
   silently drop findings. If a finding lacks `evidence` even though
   `metricsBackend.used` is true, it is because the container has under 24h of
   history; say that rather than speculating.

3. Emit confirm-gated fix buttons as fenced ` ```action ` blocks, routing on the
   exact finding `type`:
   - `noMemoryLimit` → `setResources` ONLY when the finding has `evidence`;
     otherwise advisory. Set only `limits.memory` — do not bundle an invented CPU
     limit into a memory fix.
   - `cpuThrottlingRisk` / `memoryPressure` → `setResources` (these always carry
     `evidence`). Set only the resource the finding is about.
   - `noAutoscaling` → `applyManifest` (create a HorizontalPodAutoscaler; build the
     `scaleTargetRef` and selectors from the live spec).

   Cap output at ~8 action blocks, chosen by severity then impact, one per
   consolidated workload; offer to generate the rest on request.

## Rules — evidence, not guesses

- **Never invent values you have no evidence for.** Size a `setResources` fix ONLY
  from the finding's `evidence` (observed peak over the window, plus best-practice
  headroom — a limit modestly above the observed peak). Convert to kubectl
  quantity strings for `setResources` (e.g. 0.25 cores → `250m`, 734003200 bytes →
  `~700Mi`) and say what headroom you added.
- If a finding has **no `evidence`** (no metrics backend, or too little history),
  do NOT propose specific numbers. Recommend the change qualitatively and note
  that sizing needs a metrics backend / the Right-sizing panel.
- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl get` to gather details needed to write a correct fix.
- `applyManifest` hygiene: the ` ```yaml ` block must IMMEDIATELY follow its
  ` ```action ` block (the parser attaches it as the manifest). Strip server-set
  fields (`status`, `metadata.managedFields`, `resourceVersion`, `uid`,
  `generation`, `creationTimestamp`, the `last-applied-configuration` annotation)
  from any live YAML you patch.
