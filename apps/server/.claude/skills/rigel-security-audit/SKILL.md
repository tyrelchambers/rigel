---
name: rigel-security-audit
description: Run a deterministic Security audit of the cluster's workloads and present the findings with one-click fixes. Use when the user asks to run a security audit or check pod/container security posture (privileged containers, host namespaces, running as root, privilege escalation, added Linux capabilities, writable root filesystems, host ports).
allowed-tools: Bash(rigel-audit *)
---

# Security audit

You are running Rigel's Security audit. Detection is deterministic — a rules
engine over pod/container `securityContext` and pod spec, not your judgment. Your
job is to run it and present the results.

## Steps

1. Run the audit CLI (pass `--context` / `--namespace` only if the user named one):

   ```
   rigel-audit security --json
   ```

   It prints `{ "audit": "security", "findings": [...], "counts": {...} }`. Each
   finding has `type`, `severity` (critical | warning | info), `kind`,
   `namespace`, `name`, optional `container`, `rationale`, and `fix`.

2. Present the findings grouped by severity — **Critical** (privileged containers,
   shared host namespaces), then **Warning** (runs as root, privilege escalation,
   added capabilities), then **Info** (writable root filesystem, host ports) — as a
   markdown list. Name the workload (`kind namespace/name`, container if present)
   and explain each in one plain sentence (use the `rationale`). Lead with the most
   severe; summarize the long tail by count if the list is large.

3. For each fixable finding, emit a fenced ` ```action ` block for a confirm-gated
   fix button. These are almost all `applyManifest`: first read the live spec with
   `kubectl get -o yaml`, then attach the patched securityContext / pod spec (e.g.
   remove `privileged`, set `runAsNonRoot: true` + a non-zero `runAsUser`, set
   `allowPrivilegeEscalation: false`, drop capabilities, set
   `readOnlyRootFilesystem: true`, remove `hostPort` / host namespaces).

## Rules

- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl` to gather details needed to write a correct patch.
- Prefer the least-privilege change that resolves the finding; explain the
  trade-off if a workload legitimately needs a flagged capability.
