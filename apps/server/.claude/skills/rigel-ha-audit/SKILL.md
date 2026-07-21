---
name: rigel-ha-audit
description: Run a deterministic High-availability audit of the cluster's topology and present the findings with fixes. Use when the user asks to run an HA audit or check failure tolerance, node redundancy, control-plane / etcd quorum, single points of failure, or what happens when nodes go down.
allowed-tools: Bash(rigel-audit *), Bash(kubectl get *)
---

# High-availability audit

You are running Rigel's High-availability audit. Detection is deterministic — a
rules engine over node topology and the cluster-critical singletons (CoreDNS,
ingress), not your judgment. Your job is to run it and present the results.

Unlike the workload audits, this one is about the whole cluster: control-plane /
etcd quorum, node redundancy, failure-domain concentration, and the components
whose loss takes every app down. It is always cluster-wide — there is no
`--namespace` for it.

## Steps

1. Run the audit CLI (pass `--context` only when the user named a cluster; it
   otherwise uses the active context):

   ```
   rigel-audit ha --json
   ```

   It prints `{ "audit": "ha", "findings": [...], "counts": {...} }`. Each finding
   has `type`, `severity` (critical, warning, or info), `kind` (`Cluster`, `Node`,
   or `Deployment`), `name`, `namespace`, `rationale`, and `fix`.

   If the CLI exits non-zero, relay its stderr message verbatim and stop. Do not
   retry with different flags, do not produce findings of your own, and do not
   work around a plan-gate message.

2. Open with a one-line summary derived from `counts`. If `findings` is empty, say
   the audit passed and briefly list what was checked (control-plane/etcd quorum,
   node redundancy, failure-domain spread, control-plane isolation, and
   CoreDNS/ingress single points of failure) so "clean" is meaningful, then go to
   step 4.

   Otherwise present the findings grouped by each finding's `severity` field
   (critical, then warning, then info); omit empty groups — the JSON is the source
   of truth for severity, do not reclassify by type. Within a group, order by
   `type`, then `namespace/name`. Name the subject (`control-plane`, the node
   name, or `Deployment namespace/name`) and explain each in one plain sentence
   (use the `rationale`). Never silently drop a finding.

3. Emit confirm-gated fix buttons as fenced ` ```action ` blocks **only for the
   findings that have a concrete one-cluster fix**:

   - `dnsSinglePoint`, `ingressSinglePoint` → scale the Deployment:
     `{"label":"Scale <name> to 2 replicas","kind":"scale","namespace":"<ns>","name":"<name>","replicas":<n>}` (2+).
   - `dnsNotSpread` / `ingressNotSpread` → `applyManifest`: read the live
     Deployment with `kubectl get -o yaml`, add `topologySpreadConstraints` over
     `kubernetes.io/hostname` (or pod anti-affinity), attach the patched manifest.
   - `dnsNoPodDisruptionBudget` → `applyManifest` with a new PodDisruptionBudget
     (`minAvailable: 1`) selecting the component's pod labels.
   - `controlPlaneSchedulable` → offer, with a caveat, tainting the node:
     `{"kind":"command","args":["taint","nodes","<node>","node-role.kubernetes.io/control-plane=:NoSchedule"],"label":"Taint <node> NoSchedule"}`.
     Only do this when there are dedicated worker nodes to absorb the load; say so.

   The quorum / failure-domain findings (`singleNodeCluster`,
   `controlPlaneSinglePoint`, `controlPlaneNoFailureTolerance`,
   `controlPlaneEvenCount`, `controlPlaneQuorumInOneFailureDomain`,
   `controlPlaneFailureDomainUnknown`) have **no one-click fix** — adding,
   removing, relocating, or labeling control-plane nodes is an infrastructure
   change. Present them as guidance using the `fix` text; do not emit an action
   block for them. Cap output at ~8 action blocks.

4. **When `controlPlaneFailureDomainUnknown` is present, ask — don't assume.** The
   engine can't see physical placement (the nodes carry no
   `topology.kubernetes.io/zone` labels), and a quorum of control-plane nodes
   sharing one failure domain is invisible to it yet fatal in practice — this is
   exactly how two nodes on the same LAN slip past a "clean" result. So ask the
   operator, plainly, how their control-plane/etcd nodes are physically
   distributed: are any on the same host/hypervisor, rack, switch, power feed,
   network, or site? Reason from the answer:
   - If a **quorum** of them share one domain (e.g. "2 of my 3 are on the same
     network"), spell out the concrete risk: losing that single domain drops a
     majority of etcd members, so the cluster loses quorum and the whole control
     plane freezes — even though the remaining node stays up. Then recommend
     mitigations as guidance (not buttons): move or add a node so no single domain
     holds a majority, and/or label the nodes with `topology.kubernetes.io/zone` so
     future audits verify it automatically.
   - If they're already spread across independent domains, say so and suggest
     adding the zone labels so it stays verifiable.
   Ask it as a real follow-up when the run is interactive; if you genuinely can't
   ask (non-interactive), state the risk conditionally and move on.

5. Close by naming what this audit does NOT cover, so its "clean" isn't
   overread: per-workload replica counts and spread (that's the Reliability
   audit), and distributed-storage (Longhorn/Ceph) replica factor vs. failure
   domains, which needs the storage operator's own tooling.

## Rules

- Do NOT re-run detection or invent findings beyond the CLI output. You may use
  read-only `kubectl get` to gather details needed to write a correct patch.
- **Never invent values you have no evidence for.** When scaling CoreDNS/ingress,
  2 is the safe default; only go higher if the user asks. When adding
  `topologySpreadConstraints`, use `maxSkew: 1`, `topologyKey:
  kubernetes.io/hostname`, `whenUnsatisfiable: ScheduleAnyway` (DoNotSchedule can
  wedge scheduling on a small cluster — mention the trade-off).
- Known-infrastructure caveats: on a single-node or k3s all-in-one cluster the
  control-plane findings are inherent to the setup, not mistakes — present them
  with that context rather than pushing a fix.
- `applyManifest` hygiene: the ` ```yaml ` block must IMMEDIATELY follow its
  ` ```action ` block. Before patching, strip server-set fields from the live
  YAML: `status`, `metadata.managedFields`, `metadata.resourceVersion`,
  `metadata.uid`, `metadata.generation`, `metadata.creationTimestamp`, and the
  `kubectl.kubernetes.io/last-applied-configuration` annotation.
