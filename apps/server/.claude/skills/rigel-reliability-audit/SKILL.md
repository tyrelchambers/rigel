---
name: rigel-reliability-audit
description: Run a deterministic Reliability / SRE audit of the cluster's workloads and present the findings with one-click fixes. Use when the user asks to run a reliability audit or check reliability/SRE issues (single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes).
allowed-tools: Bash(rigel-audit *), Bash(kubectl get *)
---

# Reliability audit

You are running Rigel's Reliability / SRE audit. Detection is deterministic — a
rules engine, not your judgment. Your job is to run it and present the results.

## Steps

1. Run the audit CLI. Pass `--namespace` when the user named one or the
   conversation is clearly focused on a single namespace; otherwise audit
   cluster-wide. Pass `--context` only when the user named a cluster (the CLI
   otherwise uses the active context):

   ```
   rigel-audit reliability --json
   ```

   It prints `{ "audit": "reliability", "findings": [...], "counts": {...} }`.
   Each finding has `type`, `severity` (`warning` or `info` for this audit),
   `kind`, `namespace`, `name`, optional `container`, `rationale`, and `fix`.

   If the CLI exits non-zero, relay its stderr message verbatim and stop. Do not
   retry with different flags, do not produce findings of your own, and do not
   work around a plan-gate message.

2. Open with a one-line summary derived from `counts`. If `findings` is empty,
   say the audit passed and briefly list what was checked (single replicas,
   probes, PDBs, anti-affinity, resource requests, image tags, hostPath volumes)
   so "clean" is meaningful, then stop.

   Otherwise present the findings grouped by each finding's `severity` field
   (warning, then info); omit empty groups. Within a group, order by `type`, then
   `namespace/name`. For each finding: name the workload (`kind namespace/name`,
   and container if present) and explain in one plain sentence why it is a
   reliability risk (use the `rationale`). Every finding must appear either
   individually or inside a counted rollup line — never silently drop findings.
   Roll identical `type` findings across many workloads into one line with a count
   and an expandable list rather than repeating them.

3. Emit confirm-gated fix buttons as fenced ` ```action ` blocks, routing on the
   exact finding `type`:
   - `singleReplica` → `scale` with `replicas: 2` (or match an existing HPA floor).
   - `latestImageTag` → `setImage` — read the live image first and pin a concrete
     tag or digest.
   - `noLivenessProbe` / `noReadinessProbe` → `applyManifest`, but ONLY with a
     probe you can ground in the live spec: reuse the other probe if one exists,
     or use `tcpSocket` on a declared `containerPort`. **Never invent an HTTP
     health path.** If there is no declared port to probe, present the finding as
     advisory instead of emitting an action.
   - `noPodDisruptionBudget` / `noAntiAffinity` → `applyManifest`. Build the PDB
     `matchLabels` and anti-affinity terms from the workload's actual pod-template
     labels read via `kubectl get -o yaml`; never guess label keys.
   - `hostPathVolume` → advisory only. Explain the PVC replacement and the
     data-migration step; do not emit a one-click manifest swap (it orphans the
     data on the node).
   - `missingResourceRequests` → advisory only (see the no-fabrication rule).

   Cap output at ~8 action blocks, chosen by severity then impact, and emit at
   most ONE `applyManifest` per workload that resolves all of its findings
   together (name which findings it resolves). Offer to generate fixes for the
   rest on request.

## Rules

- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl get` to gather details needed to write a correct fix.
- **Never invent values you have no evidence for** — resource quantities, health-
  check paths/ports, or label selectors. Every concrete value in a fix must come
  from the finding, its `fix`/`rationale`, or a `kubectl get` read. For a
  `missingResourceRequests` finding, recommend setting requests qualitatively and
  say the values must be sized from observed usage (a metrics backend / the
  Right-sizing panel) — do not put specific numbers in a fix. If you have no
  grounded value, present the fix as advisory.
- `applyManifest` hygiene: the ` ```yaml ` block must IMMEDIATELY follow its
  ` ```action ` block (the parser attaches it as the manifest). Before patching,
  strip server-set fields from the live YAML: `status`, `metadata.managedFields`,
  `metadata.resourceVersion`, `metadata.uid`, `metadata.generation`,
  `metadata.creationTimestamp`, and the
  `kubectl.kubernetes.io/last-applied-configuration` annotation.
