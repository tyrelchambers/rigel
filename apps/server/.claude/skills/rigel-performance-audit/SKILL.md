---
name: rigel-performance-audit
description: Run a deterministic Performance audit of the cluster's workloads and present the findings with evidence-based fixes. Use when the user asks to run a performance audit or check performance/capacity issues (missing memory limits, missing autoscaling, CPU throttling, memory pressure). Metrics-based checks require a Prometheus/VictoriaMetrics backend.
allowed-tools: Bash(rigel-audit *)
---

# Performance audit

You are running Rigel's Performance audit. Detection is deterministic. It is
**hybrid**: spec-based checks (missing memory limit, missing autoscaling) always
run; metrics-based checks (CPU throttling, memory pressure) run only when a
metrics backend is present, and those findings carry observed-usage `evidence`.

## Steps

1. Run the audit CLI (pass `--context` / `--namespace` only if the user named one):

   ```
   rigel-audit performance --json
   ```

   It prints `{ "audit": "performance", "findings": [...], "counts": {...} }`.
   Each finding has `type`, `severity`, `kind`, `namespace`, `name`, optional
   `container`, `rationale`, `fix`, and — for resource findings when a metrics
   backend was available — an `evidence` object (`cpuPeak`, `memPeak`, current
   `cpuLimit`/`memLimit`, `hoursCovered`).

2. Present the findings grouped by severity (Warning, then Info) as a markdown
   list; name the workload and explain each in one plain sentence. If the output
   shows no metrics backend was found, say so — the spec checks still ran, but CPU
   throttling / memory pressure couldn't be evaluated.

3. For each fixable finding, emit a fenced ` ```action ` block:
   - `noMemoryLimit`, `cpuThrottlingRisk`, `memoryPressure` → `setResources`
   - `noAutoscaling` → `applyManifest` (create a HorizontalPodAutoscaler)

## Rules — evidence, not guesses

- **Never fabricate CPU or memory request/limit numbers.** Size a `setResources`
  fix ONLY from the finding's `evidence` (observed peak over the window, plus
  best-practice headroom — e.g. a limit modestly above the observed peak).
- If a finding has **no `evidence`** (no metrics backend, or too little history),
  do NOT propose specific numbers. Recommend the change qualitatively and note
  that sizing needs a metrics backend / the Right-sizing panel.
- Do NOT re-run detection or invent findings beyond the CLI output.
