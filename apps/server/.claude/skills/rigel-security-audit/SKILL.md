---
name: rigel-security-audit
description: Run a deterministic Security audit of the cluster's workloads and present the findings with one-click fixes. Use when the user asks to run a security audit or check pod/container security posture (privileged containers, host namespaces, running as root, privilege escalation, added Linux capabilities, writable root filesystems, host ports).
allowed-tools: Bash(rigel-audit *), Bash(kubectl get *)
---

# Security audit

You are running Rigel's Security audit. Detection is deterministic — a rules
engine over pod/container `securityContext` and pod spec, not your judgment. Your
job is to run it and present the results.

## Steps

1. Run the audit CLI. Pass `--namespace` when the user named one or the
   conversation is clearly focused on a single namespace; otherwise audit
   cluster-wide. Pass `--context` only when the user named a cluster (the CLI
   otherwise uses the active context):

   ```
   rigel-audit security --json
   ```

   It prints `{ "audit": "security", "findings": [...], "counts": {...} }`. Each
   finding has `type`, `severity` (critical, warning, or info), `kind`,
   `namespace`, `name`, optional `container`, `rationale`, and `fix`.

   If the CLI exits non-zero, relay its stderr message verbatim and stop. Do not
   retry with different flags, do not produce findings of your own, and do not
   work around a plan-gate message.

2. Open with a one-line summary derived from `counts`. If `findings` is empty,
   say the audit passed and briefly list what was checked (privileged containers,
   host namespaces, run-as-root, privilege escalation, added capabilities,
   writable root filesystems, host ports) so "clean" is meaningful, then stop.

   Otherwise present the findings grouped by each finding's `severity` field
   (critical, then warning, then info); omit empty groups — the JSON is the source
   of truth for severity, do not reclassify by type. Within a group, order by
   `type`, then `namespace/name`. Name the workload (`kind namespace/name`,
   container if present) and explain each in one plain sentence (use the
   `rationale`). Every finding must appear either individually or inside a counted
   rollup line — never silently drop findings. Roll identical `type` findings
   across many workloads into one line with a count and an expandable list.

3. Emit confirm-gated fix buttons as fenced ` ```action ` blocks. These are almost
   all `applyManifest`: read the live spec with `kubectl get -o yaml`, then attach
   the patched securityContext / pod spec (remove `privileged`, set
   `runAsNonRoot: true`, set `allowPrivilegeEscalation: false`, drop capabilities,
   set `readOnlyRootFilesystem: true`, remove `hostPort` / host namespaces).

   A single container typically trips several findings at once, so emit ONE
   `applyManifest` per workload that resolves ALL of its securityContext findings
   together, and say which findings it resolves. **Never emit multiple full-
   manifest actions for the same workload** — each is a full snapshot of the same
   pre-fix spec, so a later click reverts an earlier one. Cap output at ~8 action
   blocks, chosen by severity then impact; offer to generate the rest on request.

## Rules

- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl get` to gather details needed to write a correct patch.
- **Never invent values you have no evidence for.** Prefer `runAsNonRoot: true`
  alone (the image's own USER applies, and a root image then fails visibly); only
  set `runAsUser` when the image's UID is actually known — never guess a UID.
  Caveat `readOnlyRootFilesystem: true` as likely needing an `emptyDir` mount for
  `/tmp` and any writable log paths.
- Prefer the least-privilege change that resolves the finding; explain the
  trade-off if a workload legitimately needs a flagged capability. Known-
  infrastructure workloads (CNI, kube-proxy, node exporters, storage drivers,
  often in `kube-system`) frequently need `hostNetwork`/`hostPID`/privileged
  settings — present those findings with that context and do not push a fix button
  for them by default.
- `applyManifest` hygiene: the ` ```yaml ` block must IMMEDIATELY follow its
  ` ```action ` block (the parser attaches it as the manifest). Before patching,
  strip server-set fields from the live YAML: `status`, `metadata.managedFields`,
  `metadata.resourceVersion`, `metadata.uid`, `metadata.generation`,
  `metadata.creationTimestamp`, and the
  `kubectl.kubernetes.io/last-applied-configuration` annotation.
