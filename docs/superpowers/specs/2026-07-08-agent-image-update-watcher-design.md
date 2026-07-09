# HELM-56 — Agent image update watcher (in-app)

## Problem

The app detects when catalog-app images are outdated (update-resolver / "up to
date" badge), but has no visibility into whether the in-cluster Rigel agent
(`deployment/rigel-assistant`) is running a stale image. After CI pushes a new
`ghcr.io/<owner>/rigel-assistant` image, an operator gets no in-app signal that
their deployed agent is behind, and no way to update it without dropping to
`kubectl`.

## Goal

Surface the agent's image freshness in the Assistant panel's status strip and
offer a guarded one-click update.

## Key constraint that shapes the approach

CI (`agent-build.yml`) currently pins the running deployment to an immutable
`:<git-sha>` tag. A git SHA is not a parseable version, so the existing
update-resolver returns "unknown" for it — all three resolver tiers (version
tags, moving-tag → newest *semver* tag, GitHub releases) rely on semver, and
there are no semver tags on the continuous track.

Rather than build digest-only detection, we make the continuously-deployed image
carry a **monotonic semver tag**. Then the existing `/api/updates` resolver, the
`useUpdates()` hook, and the catalog `setImage` update action all work unchanged.

## Design

### 1. CI — continuous semver (`.github/workflows/agent-build.yml`)

- Derive `VERSION=0.<minor>.<run_number>`, where `<minor>` is parsed from
  `agent/package.json` (today `0.1`, giving `0.1.<run_number>`). `github.run_number`
  is monotonic, so patch numbers always increase within a minor.
- Push three tags from the same build: `:latest`, `:<sha>` (kept for
  traceability), and `:0.<minor>.<run_number>`.
- The deploy step pins `kubectl set image deployment/rigel-assistant
  agent=<IMAGE>:0.<minor>.<run_number>` (replacing the `:<sha>` pin) and keeps
  `kubectl rollout status`.

**Coherence with releases.** `release-images.yml` publishes deliberate
`:X.Y.Z` / `:X.Y` / `:stable` tags on a published GitHub Release. Because the
continuous minor tracks `agent/package.json`, continuous builds
(`0.1.<large run_number>`) stay ahead of a same-minor release (`0.1.0`), so the
watcher resolves the continuous build as newest. A release that bumps the minor
requires bumping `agent/package.json` first — enforced socially by the
`cut-release` skill, which bumps `agent/package.json` in lockstep with the
release version. Transient window: between a minor bump landing and the next
continuous agent build, the running pod is still on the old minor and the watcher
may briefly show the just-published release as the update target. This is
acceptable and self-heals on the next continuous build.

### 2. Detection — reuse `/api/updates` (no server change)

The cluster watch payload already carries the full pod spec; `packages/catalog`
detection reads `spec.template.spec.containers[].image` and derives the pulled
digest from pod `imageID` via `runningImageDigest()`.

- In `apps/web/src/panels/assistant/useAssistant.ts`, read the `agent`
  container's image from the running `rigel-assistant` Deployment and the agent
  pod's running digest (both already available from the store the hook
  subscribes to).
- Feed `[{ appID: "rigel-assistant", image, runningDigest }]` into the existing
  `useUpdates()` hook → `POST /api/updates`. The resolver's version tier handles
  `0.1.<n>` with no new resolver code and returns
  `{ currentTag, latest, updateAvailable, kind, reason }`.
- Gate the query so it only runs when the agent is installed and its deployment
  is present (avoid firing during loading / not-installed phases).

### 3. UI — StatusStrip indicator

Built to Pencil frame `f14leA` ("Assistant — Agent update watcher (HELM-56)") in
`clankerlocal.pen`. The indicator lives in the strip's right cluster, to the left
of the token group, and reuses the strip's existing tokens and primitives (no new
chrome). Shown only when installed and the deployment source is ready.

States:

- **Update available** — an accent pill: `↑ <current> → <latest>` (mono, latest
  in `accent.primary`) followed by a compact **Update** button
  (`accent.primary`, inverse-foreground label). This is the only interactive
  state.
- **Up to date** — subtle green check + "Up to date" + mono `<current>`, low
  emphasis. Confirms the agent is current without drawing attention.
- **Unknown / registry unreachable** (`kind: "unknown"`) — muted cloud-off +
  "Couldn't check for updates", with the resolver's `reason` as the tooltip.
  Never alarming.

The strip already wraps on narrow widths (`flex-wrap`), so the added element
wraps below the stats when space is tight.

### 4. Update action — reuse ConfirmSheet

The Update button dispatches through the existing action path that
`AssistantContext` already hosts:

```
setPendingAction({
  kind: "setImage",
  label: `Update agent to ${latest}`,
  name: "rigel-assistant",
  namespace: <installedNamespace>,
  resourceKind: "deployment",
  container: "agent",
  image: withTag(image, latest),
})
```

The existing `ConfirmSheet` previews the exact `kubectl set image
deployment/rigel-assistant agent=<IMAGE>:<latest> -n <ns>` command and executes
via `POST /api/action`. `kubectl set image` triggers the rollout; progress shows
through the existing live pod watch (same as the catalog update pattern) — no
separate blocking `rollout status` call in-app. The indicator clears when the new
pod's tag/digest matches latest.

`withTag()` and the `setImage` ActionBlock mapping already exist and are reused
verbatim; the namespace comes from the agent deployment's actual namespace
(`installedNamespace`), not a hardcoded `default`.

### 5. Error / edge states

- **Registry unreachable** → resolver throws are caught by `handleUpdates`, which
  returns `kind: "unknown"` with a `reason`; the UI shows the muted "couldn't
  check" state with the reason in a tooltip. One image failing never fails the
  batch (the endpoint always returns 200).
- **Already latest** → `upToDate` → the subtle up-to-date state, no CTA.
- **Not installed / loading** → no indicator (query gated off).
- **Multi-cluster** → detection reads the running deployment on the active
  cluster, so freshness is per-cluster automatically.

## Testing

- `packages/catalog`: a resolver test confirming the `0.<minor>.<n>` scheme
  resolves correctly against a realistic GHCR tag set (`0.1.N`, `0.1`, `stable`,
  `latest`, `<sha>`) — newest `0.1.N` wins; `latest`/`stable`/sha are ignored.
- `apps/web`: StatusStrip render tests for the three states (update available /
  up to date / unknown), asserting the Update button appears only in the
  available state and dispatches a `setImage` action with the right
  name/namespace/container/image.
- The `setImage` action → kubectl argv mapping is already covered by existing
  `buildCommand` tests; the agent reuses it, so no new server test is required.
- CI change is verified by YAML review (not unit-testable): tag list includes the
  semver tag and the deploy pins it.

## Out of scope

- Private-registry auth (resolver stays anonymous-only, as today).
- Auto-updating the agent without confirmation.
- A dedicated rollout-status stream in the panel (the live pod watch covers it).
- Changing `release-images.yml` (already publishes the semver release tags).

## Files touched (anticipated)

- `.github/workflows/agent-build.yml` — semver tag + pinned deploy.
- `apps/web/src/panels/assistant/useAssistant.ts` — read agent image + digest,
  wire `useUpdates`.
- `apps/web/src/panels/assistant/components/StatusStrip.tsx` — indicator + states.
- `apps/web/src/panels/assistant/AssistantContext.tsx` — expose update result /
  trigger to the strip if needed (reuse existing `pendingAction` host).
- Tests alongside the above + `packages/catalog` resolver test.
