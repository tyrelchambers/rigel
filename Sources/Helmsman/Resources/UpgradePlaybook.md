# App Upgrade Playbook

You are upgrading a self-hosted app already running in the user's Kubernetes
cluster, from its current image tag to a newer one. Follow these phases in
order. Do the read-only investigation yourself; propose every cluster change as
an `action` button (never run mutations directly). Scale the depth to the app —
a trivial stateless app needs less than a stateful one — but never skip the
health gate or the verify step.

## Things to check (quick contract)

- [ ] App is healthy *now* (don't upgrade on top of a failure)
- [ ] Read the changelog current → target; note breaking changes & required config
- [ ] Major-version or multi-hop jump? Recommend the stepwise path
- [ ] New version still fits the node (resource requests)
- [ ] Stateful app? Recommend a backup first (do NOT take one without asking)
- [ ] Apply via a `setImage` action button; apply any required config first
- [ ] Watch the rollout to healthy; confirm the new tag is running
- [ ] On failure, offer a `rollback` action and explain its limits

## Phase 0 — Identify & confirm target

Restate the app, the workload(s) and namespace carrying the image, the current
tag, and the target tag (all provided in the upgrade request below). If scope is
ambiguous — multiple workloads or multiple containers run the image — enumerate
them and confirm before touching anything.

## Phase 1 — Pre-flight (read-only; finish before proposing the apply)

- **Health gate.** Confirm the app is currently healthy: pods Ready, rollout
  complete, no recent Warning events. If it is already broken, surface that and
  ask whether to proceed — do not upgrade on top of an existing failure.
- **Changelog / breaking changes.** Look up the release notes between the
  current and target versions (use web tools). Call out breaking changes,
  required env/config/secret/schema changes, and removed settings.
- **Version-skip check.** If the jump crosses a major version, or the project
  documents required intermediate versions (e.g. you must pass through vX before
  vY), flag it and recommend the stepwise path rather than a direct jump.
- **Node fit.** If the new version changes resource requests, confirm it still
  schedules on the available nodes.
- **Stateful backup.** If the app owns a database or PersistentVolumeClaim,
  state plainly that a backup or snapshot is recommended first, and show how to
  take one. Do NOT create a backup automatically or block the upgrade on it —
  let the user decide.

## Phase 2 — Plan & apply

Summarize: the tag change, the breaking changes you found, any config the user
must apply *first*, and the rollback path. Then emit the `setImage` action
button(s) for each container to retag — plus any required `setEnv`/configmap
actions, ordered so config lands before or with the image change. Apply only
when the user clicks.

## Phase 3 — Verify

Watch `kubectl rollout status`, pod readiness, and probe health; scan logs and
events for crashloops or errors for a short window. Confirm the new tag is
actually running.

## Phase 4 — Outcome

- **Success:** confirm the new version is healthy and summarize what changed.
- **Failure:** surface the failing signal (logs/events), then emit a `rollback`
  action button — `kubectl rollout undo` reverts to the pre-upgrade revision and
  tag. Explain what rollback will NOT undo: notably a database schema migration
  the new version already ran. That is why the Phase 1 backup matters.
