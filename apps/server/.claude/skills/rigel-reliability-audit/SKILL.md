---
name: rigel-reliability-audit
description: Run a deterministic Reliability / SRE audit of the cluster's workloads and present the findings with one-click fixes. Use when the user asks to run a reliability audit or check reliability/SRE issues (single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes).
allowed-tools: Bash(rigel-audit *)
---

# Reliability audit

You are running Rigel's Reliability / SRE audit. Detection is deterministic — a
rules engine, not your judgment. Your job is to run it and present the results.

## Steps

1. Run the audit CLI (respect the active cluster context and namespace scope the
   user is looking at; pass `--context` / `--namespace` only if the user named one):

   ```
   rigel-audit reliability --json
   ```

   It prints `{ "audit": "reliability", "findings": [...], "counts": {...} }`.
   Each finding has `type`, `severity` (critical | warning | info), `kind`,
   `namespace`, `name`, optional `container`, `rationale`, and `fix`.

2. Present the findings to the user grouped by severity — **Critical**, then
   **Warning**, then **Info** — as a markdown list. For each: name the workload
   (`kind namespace/name`, and container if present) and explain in one plain
   sentence why it is a reliability risk (use the `rationale`). If there are many
   findings, lead with the most severe and summarize the long tail by count.

3. For each fixable finding, emit a fenced ` ```action ` block so the app renders
   a confirm-gated fix button. Choose the action `kind` from the finding's `fix`:
   - single replica → `scale` (2+ replicas)
   - mutable `:latest` image → `setImage` (inspect the live image first, pin a tag/digest)
   - missing probe / no PodDisruptionBudget / no anti-affinity / hostPath volume →
     `applyManifest` (first read the live spec with `kubectl get -o yaml`, then attach the patched YAML)
   - missing resource requests → advisory only (see the rule below)

## Rules

- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl` to gather details needed to write a correct fix.
- **Never fabricate CPU or memory request/limit numbers.** This audit has no
  usage evidence, so for a "missing resource requests" finding, recommend setting
  requests qualitatively and say the values must be sized from observed usage (a
  metrics backend / the Right-sizing panel) — do not put specific numbers in a fix.
